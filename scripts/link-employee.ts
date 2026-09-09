/**
 * Join a MahekOne account to its HRMS employee row.
 *
 * Salary, days worked and reimbursements are read by joining `users` to
 * `employees`. Until `users.employee_id` existed that join was a guess on the
 * email or the company mobile, and on the real book it matches almost nobody:
 * 56 of 71 employees carry no email, the accounts are `@mahek.in` while the
 * sheet holds personal addresses, and the work numbers on the accounts are not
 * the company mobiles in the sheet. Every field salesman's pay read blank.
 *
 * IT PROPOSES; IT DOES NOT PICK. The matching is `lib/employee-match.ts`, pure
 * and tested, and it refuses ambiguity in BOTH directions — two payroll rows
 * folding onto one account, and two accounts folding onto one payroll row. The
 * book really does carry `Pritesh Doshi` and `Pritesh Bipin Doshi` at two
 * different salaries sharing one company mobile, so choosing between them is
 * choosing what somebody is paid, and this refuses to.
 *
 *   npm run employee:link                 # what it would do, writing nothing
 *   npm run employee:link -- --apply      # write the unambiguous ones
 *   npm run employee:link -- --user pritesh@mahek.in --employee EMP-5527 --apply
 *   npm run employee:link -- --user pritesh@mahek.in --employee none --apply
 *
 * The third form is the answer to everything it refused: one person, named by
 * hand, because somebody looked at the two rows and decided. The fourth undoes
 * a link — the account falls back to the old guess, which is where it was.
 *
 * `--all` widens it past the field app. By default only accounts that hold the
 * Salesman App are considered, because those are the ones whose pay is read.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db";
import { appAccess, employees, users } from "../src/db/schema";
import {
  proposeEmployeeLinks,
  type AccountToMatch,
  type EmployeeCandidate,
} from "../src/lib/employee-match";

type Args = { apply: boolean; user: string | null; employee: string | null; all: boolean };

/**
 * An unknown flag is REFUSED rather than ignored — the rule `lib/job-args.ts`
 * exists for. A flag silently dropped once already made a run report "bills
 * skipped" as though it were a fact about the data.
 */
function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false, user: null, employee: null, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--apply") out.apply = true;
    else if (a === "--all") out.all = true;
    else if (a === "--user" || a === "--employee") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${a} needs a value.`);
      if (a === "--user") out.user = value;
      else out.employee = value;
    } else throw new Error(`Unknown option ${a}.`);
  }
  if (out.employee && !out.user) throw new Error("--employee needs --user to say whose it is.");
  return out;
}

async function candidates(): Promise<EmployeeCandidate[]> {
  const rows = await db
    .select({
      id: employees.id,
      employeeCode: employees.employeeCode,
      name: employees.name,
      email: employees.email,
      companyMobile: employees.companyMobile,
      personalMobile: employees.personalMobile,
      sheetStatus: employees.sheetStatus,
    })
    .from(employees);
  /* A withdrawn row is somebody the sheet no longer carries. Linking an account
     to one would tie live pay to a record HR has stopped maintaining. */
  return rows.filter((r) => r.sheetStatus !== "withdrawn");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const staff = await candidates();

  /* ------------------------------------------------ naming one person by hand */
  if (args.user && args.employee) {
    const [person] = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(sql`${users.email} = ${args.user} or ${users.id} = ${args.user}`)
      .limit(1);
    if (!person) return void console.log(`No account matches "${args.user}".`);

    if (args.employee.toLowerCase() === "none") {
      console.log(
        `${args.apply ? "Unlinking" : "Would unlink"} ${person.name} <${person.email}> — pay falls back to the email-or-mobile guess.`,
      );
      if (args.apply) {
        await db.update(users).set({ employeeId: null }).where(eq(users.id, person.id));
        console.log("  Written.");
      } else console.log("  Dry run — nothing written. Add --apply.");
      return;
    }

    const match = staff.find(
      (e) => e.employeeCode === args.employee || e.id === args.employee,
    );
    if (!match) return void console.log(`No employee matches "${args.employee}".`);

    const [clash] = await db
      .select({ name: users.name })
      .from(users)
      .where(and(eq(users.employeeId, match.id), sql`${users.id} <> ${person.id}`))
      .limit(1);
    if (clash) {
      /* Caught here so the message names the other account. Left to the unique
         index it would be a constraint violation naming neither. */
      return void console.log(
        `${match.employeeCode} ${match.name} is already linked to ${clash.name}. Unlink that account first.`,
      );
    }

    console.log(
      `${args.apply ? "Linking" : "Would link"} ${person.name} <${person.email}> to ${match.employeeCode} ${match.name}.`,
    );
    if (args.apply) {
      await db.update(users).set({ employeeId: match.id }).where(eq(users.id, person.id));
      console.log("  Written.");
    } else console.log("  Dry run — nothing written. Add --apply.");
    return;
  }

  /* ------------------------------------------------------- proposing them all */
  const base = db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      active: users.active,
      linked: users.employeeId,
    })
    .from(users);

  const accounts = args.all
    ? await base.where(eq(users.active, true))
    : await base
        .innerJoin(appAccess, eq(appAccess.userId, users.id))
        .where(and(eq(appAccess.app, "field"), eq(users.active, true)));

  if (!accounts.length) {
    console.log(
      args.all ? "No active accounts." : "Nobody holds the Salesman App, so no pay is being read.",
    );
    return;
  }

  const byId = new Map(staff.map((e) => [e.id, e]));
  const unlinked = accounts.filter((a) => !a.linked);

  console.log(
    `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}; ${staff.length} employees in the master.\n`,
  );

  for (const a of accounts.filter((x) => x.linked)) {
    const e = byId.get(a.linked!);
    console.log(`  = ${a.name} <${a.email}>\n      already linked to ${e ? `${e.employeeCode} ${e.name}` : a.linked}`);
  }

  const proposals = proposeEmployeeLinks(
    unlinked.map((a): AccountToMatch => ({ id: a.id, name: a.name, email: a.email, phone: a.phone })),
    staff,
  );

  const writable: { userId: string; employeeId: string }[] = [];
  for (const p of proposals) {
    const label = `${p.account.name} <${p.account.email}>`;
    if (p.status === "matched") {
      const e = byId.get(p.employeeId)!;
      writable.push({ userId: p.account.id, employeeId: p.employeeId });
      console.log(`  + ${label}\n      ${e.employeeCode} ${e.name} — on the ${p.on}`);
    } else if (p.status === "ambiguous") {
      console.log(`  ? ${label}\n      ${p.note} — skipped, name it by hand`);
    } else {
      console.log(`  · ${label}\n      no employee matches — skipped`);
    }
  }

  console.log(
    `\n${writable.length} of ${unlinked.length} unlinked ${unlinked.length === 1 ? "account" : "accounts"} can be settled automatically.`,
  );

  if (!args.apply) {
    console.log("Dry run — nothing written. Add --apply.");
    return;
  }
  for (const w of writable) {
    await db.update(users).set({ employeeId: w.employeeId }).where(eq(users.id, w.userId));
  }
  console.log(`Written ${writable.length}.`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
