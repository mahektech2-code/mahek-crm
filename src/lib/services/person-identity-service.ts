import "server-only";
import { randomUUID } from "node:crypto";
import { cache } from "react";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customers, employeeReporting, employees, personNameAliases, users } from "@/db/schema";
import { buildDirectory, personKey, type Directory } from "@/lib/engines/person-directory";
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

type Exec = Pick<typeof db, "select" | "insert" | "update" | "execute">;

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

/** Remember a spelling a person has carried. Idempotent. */
export async function rememberName(
  exec: Exec,
  employeeId: string,
  name: string | null | undefined,
  source: string,
  actorId: string | null = null,
): Promise<void> {
  const key = personKey(name);
  if (!key || key === "(NO NAME IN THE SHEET)") return;
  await exec
    .insert(personNameAliases)
    .values({ id: `pna_${randomUUID().replace(/-/g, "").slice(0, 16)}`, nameKey: key, name: name!.trim(), employeeId, source, createdById: actorId })
    .onConflictDoNothing();
}

/**
 * Carry ONE person's new name everywhere it is copied.
 *
 *   • the old name becomes a remembered spelling of this employee;
 *   • every account that IS this employee (the stored link, or the unique
 *     strong match the directory infers for an unlinked one) takes the new
 *     name and initials — and its sheet name, where that was the old name;
 *   • the name copies on customers' seats that meant this person move too:
 *     a seat held by one of those accounts, or a name-only seat whose text
 *     resolved to this employee and nobody else.
 *
 * Every write is keyed on an id or on the old spelling resolving to exactly
 * this person, so a namesake is never renamed by accident.
 */
export async function renameEmployee(
  exec: Exec,
  input: { employeeId: string; oldName: string | null; newName: string; actorId: string | null; source: string },
): Promise<{ accounts: number; seats: number }> {
  const newName = input.newName.trim();
  if (!newName || newName === "(no name in the sheet)") return { accounts: 0, seats: 0 };

  const dir = await loadPersonDirectory(exec);
  const accountRows = await exec
    .select({ id: users.id, name: users.name, salesPersonName: users.salesPersonName })
    .from(users);
  const mine = accountRows.filter((a) => dir.employeeOfAccount(a.id) === input.employeeId);

  /* Every spelling that meant this person before today, resolved against the
     directory as it stood — so a spelling another employee also answers to is
     never treated as this one's. */
  const oldSpellings = new Set<string>();
  for (const s of [input.oldName, ...mine.map((a) => a.name)]) {
    const k = personKey(s);
    if (k && k !== personKey(newName) && dir.employeeByName(s) === input.employeeId) oldSpellings.add(k);
  }

  if (input.oldName) await rememberName(exec, input.employeeId, input.oldName, input.source, input.actorId);
  for (const a of mine) await rememberName(exec, input.employeeId, a.name, input.source, input.actorId);

  let accounts = 0;
  for (const a of mine) {
    const sheetNameWasOld = a.salesPersonName != null && oldSpellings.has(personKey(a.salesPersonName));
    if (a.name === newName && !sheetNameWasOld) continue;
    await exec
      .update(users)
      .set({
        name: newName,
        initials: initialsOf(newName),
        ...(sheetNameWasOld ? { salesPersonName: newName } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, a.id));
    accounts++;
    if (a.name !== newName) {
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
  }

  /* The seats. The fold matches what the sheet projection writes. */
  const fold = (col: unknown) => sql`upper(regexp_replace(btrim(coalesce(${col}, '')), '[[:space:]]+', ' ', 'g'))`;
  const ids = mine.map((a) => a.id);
  const keys = [...oldSpellings];
  const heldBy = (idCol: unknown) =>
    ids.length ? sql`${idCol} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})` : sql`false`;
  const named = (nameCol: unknown) =>
    keys.length ? sql`${fold(nameCol)} in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})` : sql`false`;

  let seats = 0;
  const run = async (q: Promise<unknown[]>) => {
    seats += (await q).length;
  };
  /* Sales: the text is the sheet's, so only where it was this person's old
     spelling — a seat filled with some other text by the sheet is left alone. */
  await run(
    exec
      .update(customers)
      .set({ salesPersonName: newName })
      .where(and(isNotNull(customers.salesPersonName), named(customers.salesPersonName)))
      .returning({ id: customers.id }),
  );
  await run(
    exec
      .update(customers)
      .set({ backOfficeName: newName })
      .where(and(isNotNull(customers.backOfficeName), sql`(${heldBy(customers.backOfficeAmId)} or ${named(customers.backOfficeName)})`))
      .returning({ id: customers.id }),
  );
  await run(
    exec
      .update(customers)
      .set({ salesManagerPersonName: newName })
      .where(
        and(
          isNotNull(customers.salesManagerPersonName),
          sql`(${heldBy(customers.salesManagerId)} or ${named(customers.salesManagerPersonName)})`,
        ),
      )
      .returning({ id: customers.id }),
  );
  return { accounts, seats };
}

/**
 * Bring every linked account level with its employee's name.
 *
 * Run after every employee-sheet pass and nightly: it is what makes a rename
 * typed straight into the sheet reach the account, and what repairs any drift
 * left by a path that changed one side alone. Idempotent — a book in step
 * costs two reads.
 */
export async function alignAccountNames(actorId: string | null = null): Promise<number> {
  const rows = await db
    .select({ employeeId: employees.id, employeeName: employees.name, accountName: users.name })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(sql`${users.name} <> ${employees.name} and ${employees.name} <> '(no name in the sheet)' and btrim(${employees.name}) <> ''`);
  let n = 0;
  for (const r of rows) {
    await db.transaction(async (tx) => {
      await renameEmployee(tx, {
        employeeId: r.employeeId,
        oldName: r.accountName,
        newName: r.employeeName,
        actorId,
        source: "sheet-rename",
      });
    });
    n++;
  }
  return n;
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
 * Rename an account that is NOT linked to an HRMS record: the account and the
 * name copies on the seats IT holds, by id. (A linked account is renamed
 * through its employee — `renameEmployee` — so the two never disagree.)
 */
export async function renameUnlinkedAccount(
  exec: Exec,
  input: { userId: string; oldName: string; newName: string },
): Promise<number> {
  const newName = input.newName.trim();
  const oldKey = personKey(input.oldName);
  const fold = (col: unknown) => sql`upper(regexp_replace(btrim(coalesce(${col}, '')), '[[:space:]]+', ' ', 'g'))`;
  const [acct] = await exec.select({ spn: users.salesPersonName }).from(users).where(eq(users.id, input.userId));
  const sheetNameWasOld = acct?.spn != null && personKey(acct.spn) === oldKey;
  await exec
    .update(users)
    .set({ name: newName, initials: initialsOf(newName), ...(sheetNameWasOld ? { salesPersonName: newName } : {}), updatedAt: new Date() })
    .where(eq(users.id, input.userId));
  let seats = 0;
  seats += (await exec
    .update(customers)
    .set({ salesPersonName: newName })
    .where(and(eq(customers.salesAmId, input.userId), sql`${fold(customers.salesPersonName)} = ${oldKey}`))
    .returning({ id: customers.id })).length;
  seats += (await exec
    .update(customers)
    .set({ backOfficeName: newName })
    .where(and(eq(customers.backOfficeAmId, input.userId), isNotNull(customers.backOfficeName)))
    .returning({ id: customers.id })).length;
  seats += (await exec
    .update(customers)
    .set({ salesManagerPersonName: newName })
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
