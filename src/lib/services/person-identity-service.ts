import "server-only";
import { randomUUID } from "node:crypto";
import { cache } from "react";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customers, employeeReporting, employees, personNameAliases, users } from "@/db/schema";
import { buildDirectory, personKey, staffAccountOf, type Directory, type StaffMatch } from "@/lib/engines/person-directory";
import { initialsOf } from "@/lib/format";

/* ---------------------------------------------------------------------------
 * ONE PERSON, ONE NAME — and every question about them answered by id.
 *
 * The rules live in `lib/engines/person-directory.ts`; this file does the I/O:
 *
 *   `personDirectory()` — the directory, read once per request. Every "who is
 *   this salesman's manager", "which account does this sheet name mean" goes
 *   through it, never through a comparison of name strings.
 *
 *   `renameEmployee()` / `alignAccountNames()` — HRMS is where a person's name
 *   lives. When it changes (the HRMS form, the employee sheet, a reparse) the
 *   linked login account takes the new name, the old one is remembered as a
 *   spelling of the same person, and the name copies stored on customers'
 *   seats move with it. Nothing anywhere has to be renamed twice.
 * ------------------------------------------------------------------------- */

type Exec = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute">;

export async function loadPersonDirectory(exec: Exec = db): Promise<Directory> {
  const [emps, accounts, links, aliases] = await Promise.all([
    exec
      .select({
        id: employees.id,
        name: employees.name,
        email: employees.email,
        companyMobile: employees.companyMobile,
        personalMobile: employees.personalMobile,
        status: employees.status,
        sheetStatus: employees.sheetStatus,
      })
      .from(employees),
    exec
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: users.phone,
        employeeId: users.employeeId,
        active: users.active,
        salesPersonName: users.salesPersonName,
        notEmployee: users.notEmployee,
      })
      .from(users),
    exec
      .select({ employeeId: employeeReporting.employeeId, managerId: employeeReporting.managerId })
      .from(employeeReporting),
    exec.select({ key: personNameAliases.nameKey, employeeId: personNameAliases.employeeId }).from(personNameAliases),
  ]);
  return buildDirectory({
    employees: emps.map((e) => ({ ...e, active: e.status !== "inactive" && e.sheetStatus !== "withdrawn" })),
    accounts,
    links,
    aliases,
  });
}

/** Request-memoised. Outside a request (a job) it simply reads. */
export const personDirectory = cache(() => loadPersonDirectory());

/**
 * A staff name → one account id, or a reason there is none (`staffAccountOf`).
 * For the places a name still arrives as text — an old row, a sheet, a stale
 * browser tab — so it is turned into the person once and stored by id.
 */
export async function loadStaffResolver(exec: Exec = db): Promise<(text: string | null | undefined) => StaffMatch> {
  const [dir, accounts] = await Promise.all([
    loadPersonDirectory(exec),
    exec.select({ id: users.id, employeeId: users.employeeId }).from(users),
  ]);
  return staffAccountOf(dir, accounts);
}

export type StaffChoice = { id: string; name: string; employeeId: string | null; dept: string | null; position: string | null };

/**
 * The people a "who" picker offers: live accounts of somebody on HRMS, by
 * account id, named as their account is named today. `include` adds the
 * account a record already holds, even one switched off since, so editing
 * that record never shows a blank or loses who it was.
 */
export async function staffChoices(include: ReadonlyArray<string | null | undefined> = []): Promise<StaffChoice[]> {
  const keep = [...new Set(include.filter((x): x is string => !!x))];
  const rows = (await db.execute(sql`
    select u.id, u.name, u.employee_id as "employeeId", e.department as dept, e.position
      from users u
      left join employees e on e.id = u.employee_id
     where (u.active and e.status = 'active')
        ${keep.length ? sql`or u.id in (${sql.join(keep.map((k) => sql`${k}`), sql`, `)})` : sql``}
     order by u.name
  `)) as unknown as StaffChoice[];
  return rows.map((r) => ({ id: r.id, name: r.name, employeeId: r.employeeId ?? null, dept: r.dept ?? null, position: r.position ?? null }));
}

const fold = (col: unknown) => sql`upper(regexp_replace(btrim(coalesce(${col}, '')), '[[:space:]]+', ' ', 'g'))`;

/**
 * Does anybody ELSE answer to this spelling — today's name of another
 * employee, or a spelling another employee is remembered by? A spelling two
 * people share can never be used to move anything.
 */
export async function spellingTakenByOthers(exec: Exec, employeeId: string | null, name: string): Promise<string[]> {
  const key = personKey(name);
  if (!key) return [];
  const rows = (await exec.execute(sql`
    select e.name from employees e
     where ${fold(sql`e.name`)} = ${key} ${employeeId ? sql`and e.id <> ${employeeId}` : sql``}
    union
    select e.name from person_name_aliases a join employees e on e.id = a.employee_id
     where a.name_key = ${key} ${employeeId ? sql`and a.employee_id <> ${employeeId}` : sql``}
  `)) as unknown as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * Remember a spelling a person has carried. Idempotent, and REFUSED where
 * somebody else answers to it — a shared spelling resolves to nobody anyway,
 * and storing it would only let it point at the wrong one later.
 */
export async function rememberName(
  exec: Exec,
  employeeId: string,
  name: string | null | undefined,
  source: string,
  actorId: string | null = null,
): Promise<boolean> {
  const key = personKey(name);
  if (!key || key === "(NO NAME IN THE SHEET)") return false;
  if ((await spellingTakenByOthers(exec, employeeId, name!)).length) return false;
  await exec
    .insert(personNameAliases)
    .values({ id: `pna_${randomUUID().replace(/-/g, "").slice(0, 16)}`, nameKey: key, name: name!.trim(), employeeId, source, createdById: actorId })
    .onConflictDoNothing();
  return true;
}

/** Forget the spellings an account's own name added to an employee — on unlink or relink. */
export async function forgetAccountSpellings(exec: Exec, userId: string): Promise<void> {
  await exec.delete(personNameAliases).where(eq(personNameAliases.source, `account:${userId}`));
}

/**
 * Carry ONE person's new name everywhere it is copied.
 *
 *   • the old name becomes a remembered spelling of this employee — only
 *     where nobody else answers to it;
 *   • every account LINKED to this employee (`users.employee_id`, the stored
 *     link — never a guess, so a reassigned SIM cannot rename somebody else)
 *     takes the new name and initials. Its `sales_person_name` is left alone:
 *     that is what the SHEET calls them, and the field book still reads it;
 *   • the names stored on customers' seats that meant this person move too —
 *     a seat held by one of those accounts, or text that is one of this
 *     person's old spellings and nobody else's — and the row is touched so a
 *     handset pulls the new name. Skipped where the NEW name is somebody
 *     else's as well: writing a shared name onto a seat would orphan it.
 */
export async function renameEmployee(
  exec: Exec,
  input: { employeeId: string; oldName: string | null; newName: string; actorId: string | null; source: string },
): Promise<{ accounts: number; seats: number }> {
  const newName = input.newName.trim().replace(/\s+/g, " ");
  if (!newName || newName === "(no name in the sheet)") return { accounts: 0, seats: 0 };

  const mine = await exec
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.employeeId, input.employeeId));

  const oldSpellings = new Set<string>();
  const consider = async (name: string | null | undefined, source: string) => {
    const k = personKey(name);
    if (!k || k === personKey(newName)) return;
    if (await rememberName(exec, input.employeeId, name, source, input.actorId)) oldSpellings.add(k);
  };
  await consider(input.oldName, input.source);
  for (const a of mine) await consider(a.name, `account:${a.id}`);

  let accounts = 0;
  for (const a of mine) {
    if (a.name === newName) continue;
    await exec
      .update(users)
      .set({ name: newName, initials: initialsOf(newName), updatedAt: new Date() })
      .where(eq(users.id, a.id));
    accounts++;
    await exec.insert(auditLog).values({
      id: `aud_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      actorId: input.actorId,
      action: "person.renamed",
      entityType: "user",
      entityId: a.id,
      beforeState: { name: a.name },
      afterState: { name: newName, source: input.source },
    });
  }

  if ((await spellingTakenByOthers(exec, input.employeeId, newName)).length) return { accounts, seats: 0 };

  const ids = mine.map((a) => a.id);
  const keys = [...oldSpellings];
  const heldBy = (idCol: unknown) =>
    ids.length ? sql`${idCol} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})` : sql`false`;
  const named = (nameCol: unknown) =>
    keys.length ? sql`${fold(nameCol)} in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})` : sql`false`;
  const now = new Date();
  let seats = 0;
  seats += (await exec
    .update(customers)
    .set({ salesPersonName: newName, updatedAt: now })
    .where(and(isNotNull(customers.salesPersonName), named(customers.salesPersonName)))
    .returning({ id: customers.id })).length;
  seats += (await exec
    .update(customers)
    .set({ backOfficeName: newName, updatedAt: now })
    .where(and(isNotNull(customers.backOfficeName), sql`${customers.backOfficeName} <> ${newName}`, sql`(${heldBy(customers.backOfficeAmId)} or ${named(customers.backOfficeName)})`))
    .returning({ id: customers.id })).length;
  seats += (await exec
    .update(customers)
    .set({ salesManagerPersonName: newName, updatedAt: now })
    .where(
      and(
        isNotNull(customers.salesManagerPersonName),
        sql`${customers.salesManagerPersonName} <> ${newName}`,
        sql`(${heldBy(customers.salesManagerId)} or ${named(customers.salesManagerPersonName)})`,
      ),
    )
    .returning({ id: customers.id })).length;
  return { accounts, seats };
}

/**
 * Bring every linked account level with its employee's name.
 *
 * Run after every employee-sheet pass and nightly: it is what makes a rename
 * typed straight into the sheet reach the account. Only a real difference
 * counts — case and spacing are not a rename, so a sheet that writes names in
 * capitals does not shout every login's name overnight.
 */
export async function alignAccountNames(actorId: string | null = null, opts: { dryRun?: boolean } = {}): Promise<number> {
  const rows = await accountNameDrift();
  if (opts.dryRun) return rows.length;
  for (const r of rows) {
    await db.transaction(async (tx) => {
      await renameEmployee(tx, {
        employeeId: r.employeeId,
        oldName: null,
        newName: r.employeeName,
        actorId,
        source: "sheet-rename",
      });
    });
  }
  return rows.length;
}

/** Linked accounts whose name differs from their HRMS record's — beyond case and spacing. */
export async function accountNameDrift(): Promise<Array<{ userId: string; accountName: string; employeeId: string; employeeName: string }>> {
  return db
    .select({ userId: users.id, accountName: users.name, employeeId: employees.id, employeeName: employees.name })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(
      sql`${fold(users.name)} <> ${fold(employees.name)} and ${employees.name} <> '(no name in the sheet)' and btrim(${employees.name}) <> ''`,
    );
}

/** Old names seen on rows a sheet pass is about to overwrite. */
export async function rememberSheetRenames(
  before: ReadonlyArray<{ id: string; name: string }>,
  after: ReadonlyMap<string, string>,
): Promise<void> {
  for (const b of before) {
    const next = after.get(b.id);
    if (next && personKey(next) !== personKey(b.name)) await rememberName(db, b.id, b.name, "sheet-rename");
  }
}

/**
 * Rename an account that is NOT linked to an HRMS record: the account, and
 * the back office and sales manager seats IT holds by id. (A linked account is
 * renamed through its employee — `renameEmployee`.)
 *
 * The salesperson text and `users.sales_person_name` are left alone on
 * purpose: they are how the party sheet spells this person, and the field
 * book matches on that spelling — rewriting it would take every shop the
 * sheet still names the old way off their handset. Link them to HRMS to have
 * the old spelling remembered.
 */
export async function renameUnlinkedAccount(
  exec: Exec,
  input: { userId: string; oldName: string; newName: string },
): Promise<number> {
  const newName = input.newName.trim();
  const now = new Date();
  await exec
    .update(users)
    .set({ name: newName, initials: initialsOf(newName), updatedAt: now })
    .where(eq(users.id, input.userId));
  let seats = 0;
  seats += (await exec
    .update(customers)
    .set({ backOfficeName: newName, updatedAt: now })
    .where(and(eq(customers.backOfficeAmId, input.userId), isNotNull(customers.backOfficeName)))
    .returning({ id: customers.id })).length;
  seats += (await exec
    .update(customers)
    .set({ salesManagerPersonName: newName, updatedAt: now })
    .where(and(eq(customers.salesManagerId, input.userId), isNotNull(customers.salesManagerPersonName)))
    .returning({ id: customers.id })).length;
  return seats;
}

/* ------------------------------------------------- the org chart from titles */

/**
 * Write the org-chart links the sheet's Report To titles prove — one active
 * holder of the title, nobody already on the chart, no circle — and return
 * the people HR has to place by hand. See `engines/org-from-titles.ts`.
 * Idempotent: a second run finds nothing left to place.
 */
export async function placeByTitles(): Promise<{
  placed: number;
  ambiguous: Array<{ name: string; title: string }>;
  unknown: Array<{ name: string; title: string }>;
}> {
  const { planChartFromTitles } = await import("@/lib/engines/org-from-titles");
  const [people, links] = await Promise.all([
    db
      .select({
        id: employees.id,
        name: employees.name,
        position: employees.position,
        reportsTo: employees.reportsTo,
        status: employees.status,
        sheetStatus: employees.sheetStatus,
      })
      .from(employees),
    db.select({ employeeId: employeeReporting.employeeId, managerId: employeeReporting.managerId }).from(employeeReporting),
  ]);
  const plan = planChartFromTitles(
    people.map((p) => ({ ...p, active: p.status === "active" && p.sheetStatus !== "withdrawn" })),
    links,
  );
  if (plan.place.length) {
    await db
      .insert(employeeReporting)
      .values(plan.place.map((l) => ({ id: `rep_${randomUUID().replace(/-/g, "").slice(0, 16)}`, ...l })))
      // A link somebody made between the read and this write wins.
      .onConflictDoNothing();
  }
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  return {
    placed: plan.place.length,
    ambiguous: plan.ambiguous.map((a) => ({ name: nameOf.get(a.employeeId) ?? a.employeeId, title: a.title })),
    unknown: plan.unknown.map((a) => ({ name: nameOf.get(a.employeeId) ?? a.employeeId, title: a.title })),
  };
}

/* ------------------------------------------------- accounts ↔ HRMS records */

/**
 * Store the account ↔ employee links the data PROVES: a unique email or a
 * unique mobile, unique on both sides, and the employee not already somebody
 * else's. A name match is never stored here — it is only suggested on Admin →
 * Manage access for a person to confirm. Accounts marked not-an-employee are
 * left alone. Idempotent.
 */
export async function autoLinkAccounts(): Promise<number> {
  const dir = await loadPersonDirectory();
  const open = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(sql`${users.employeeId} is null`, eq(users.notEmployee, false)));
  let n = 0;
  for (const a of open) {
    const how = dir.howLinked(a.id);
    if (how !== "email" && how !== "mobile") continue;
    const employeeId = dir.employeeOfAccount(a.id)!;
    const done = await db
      .update(users)
      .set({ employeeId, updatedAt: new Date() })
      .where(
        and(
          eq(users.id, a.id),
          sql`${users.employeeId} is null`,
          sql`not exists (select 1 from users u2 where u2.employee_id = ${employeeId})`,
        ),
      )
      .returning({ id: users.id });
    if (!done.length) continue;
    n++;
    await db.insert(auditLog).values({
      id: `aud_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      actorId: null,
      action: "link-employee",
      entityType: "user",
      entityId: a.id,
      afterState: { employeeId, how, automatic: true },
    });
  }
  return n;
}

/* ------------------------------------------------ the rest of their details */

const tenDigits = (v: string | null | undefined) => {
  const d = (v ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

/**
 * HR changed somebody's company mobile or email in HRMS: the linked account
 * follows — but ONLY where it still carried the old value (it was copied from
 * HRMS, so it means the same thing), only to a valid value, and never onto a
 * number or address another account signs in with. A blank in HRMS never
 * removes how somebody signs in. Returns what moved, in words.
 */
export async function carryContactDetails(
  exec: Exec,
  employeeId: string,
  before: { companyMobile: string | null; email: string | null },
  after: { companyMobile?: string | null; email?: string | null },
): Promise<string[]> {
  const linked = await exec
    .select({ id: users.id, phone: users.phone, email: users.email })
    .from(users)
    .where(eq(users.employeeId, employeeId));
  if (!linked.length) return [];
  const said: string[] = [];
  const oldPhone = tenDigits(before.companyMobile);
  const newPhone = tenDigits(after.companyMobile);
  const oldEmail = (before.email ?? "").trim().toLowerCase() || null;
  const newEmail = (after.email ?? "").trim().toLowerCase() || null;
  for (const a of linked) {
    if (after.companyMobile !== undefined && oldPhone && newPhone && newPhone !== oldPhone && a.phone === oldPhone && /^[6-9]\d{9}$/.test(newPhone)) {
      const [taken] = await exec.select({ id: users.id }).from(users).where(and(eq(users.phone, newPhone), sql`${users.id} <> ${a.id}`)).limit(1);
      if (taken) said.push(`the work number ${newPhone} is another account's, so their sign-in number was left as it was`);
      else {
        await exec.update(users).set({ phone: newPhone, updatedAt: new Date() }).where(eq(users.id, a.id));
        said.push(`their sign-in number is now ${newPhone}`);
      }
    }
    if (after.email !== undefined && oldEmail && newEmail && newEmail !== oldEmail && newEmail.includes("@") && (a.email ?? "").toLowerCase() === oldEmail) {
      const [taken] = await exec.select({ id: users.id }).from(users).where(and(sql`lower(${users.email}) = ${newEmail}`, sql`${users.id} <> ${a.id}`)).limit(1);
      if (taken) said.push(`${newEmail} is another account's, so their sign-in email was left as it was`);
      else {
        await exec.update(users).set({ email: newEmail, updatedAt: new Date() }).where(eq(users.id, a.id));
        said.push(`their sign-in email is now ${newEmail}`);
      }
    }
  }
  return said;
}
