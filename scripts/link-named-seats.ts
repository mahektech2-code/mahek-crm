/* ---------------------------------------------------------------------------
 * A NAME ON THE COVER, NOBODY'S DRAWER.
 *
 * Records the sheets brought in carry the salesperson / back office person as
 * TEXT beside the seat that decides whose they are (`sales_am_id`,
 * `back_office_am_id`). Where the text names exactly one person with an
 * active account and the seat is EMPTY, this fills the seat with that account.
 * Any kind of record — lead or customer.
 *
 * Owner's rule (2026-11-18): every piece of data hangs off the user id; the
 * name is a label. On prod this found 659 leads named for five salesmen and
 * assigned to none of them.
 *
 * What it never does: overwrite a seat somebody already holds (a disagreement
 * is a person's call), guess at a name that matches nobody or several, or
 * notify anyone. It writes the same history row and audit row a reassignment
 * does, and keeps the lead's handset holders in step.
 *
 *   tsx --conditions=react-server --env-file=<env> scripts/link-named-seats.ts [--dry-run]
 * ------------------------------------------------------------------------- */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { db } from "../src/db";
import { auditLog, customerAmChanges, customers, users } from "../src/db/schema";
import { loadPersonDirectory } from "../src/lib/services/person-identity-service";
import { syncLeadHolders } from "../src/lib/services/lead-tombstone";

const dryRun = process.argv.includes("--dry-run");
const id = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const REASON = "Correcting a mistake";
const NOTE = "The record named this person but was not assigned to them; linked to their account.";

type Seat = { role: "sales" | "back_office"; idCol: "salesAmId" | "backOfficeAmId"; nameCol: "salesPersonName" | "backOfficeName" };
const SEATS: Seat[] = [
  { role: "sales", idCol: "salesAmId", nameCol: "salesPersonName" },
  { role: "back_office", idCol: "backOfficeAmId", nameCol: "backOfficeName" },
];

async function main() {
  const dir = await loadPersonDirectory();
  const allUsers = await db.select({ id: users.id, name: users.name, active: users.active, employeeId: users.employeeId }).from(users);
  const active = new Map(allUsers.map((u) => [u.id, u]));
  /* The directory answers with ACTIVE accounts only. Somebody who has left
     still owns the history they made, so a record naming them links to their
     own (switched-off) account — the stored link, one account per employee. */
  const accountOf = (text: string): string | null => {
    const live = dir.accountByName(text);
    if (live) return live;
    const emp = dir.employeeByName(text);
    if (!emp) return null;
    const theirs = allUsers.filter((u) => u.employeeId === emp);
    return theirs.length === 1 ? theirs[0].id : null;
  };

  const plan: Array<{ customerId: string; kind: "lead" | "customer"; seat: Seat; text: string; userId: string; formerHolders: (string | null)[] }> = [];
  const skipped = new Map<string, number>();
  const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1);

  for (const seat of SEATS) {
    const rows = await db
      .select({
        id: customers.id,
        kind: customers.kind,
        text: customers[seat.nameCol],
        ownerId: customers.ownerId,
        salesAmId: customers.salesAmId,
        backOfficeAmId: customers.backOfficeAmId,
      })
      .from(customers)
      .where(and(isNull(customers[seat.idCol]), isNotNull(customers[seat.nameCol]), sql`btrim(${customers[seat.nameCol]}) <> ''`));
    for (const r of rows) {
      const text = r.text!;
      const status = dir.nameStatus(text);
      if (status !== "one") { skip(`${seat.role}: "${text}" names ${status === "none" ? "nobody" : "several people"}`); continue; }
      const userId = accountOf(text);
      if (!userId) { skip(`${seat.role}: "${text}" has no account`); continue; }
      plan.push({ customerId: r.id, kind: r.kind, seat, text, userId, formerHolders: [r.ownerId, r.salesAmId, r.backOfficeAmId] });
    }
  }

  const byPerson = new Map<string, number>();
  for (const p of plan) {
    const u = active.get(p.userId)!;
    const k = `${p.seat.role} → ${u.name}${u.active ? "" : " [left]"} (${p.kind})`;
    byPerson.set(k, (byPerson.get(k) ?? 0) + 1);
  }
  console.log(`${dryRun ? "WOULD LINK" : "LINKING"} ${plan.length} seats`);
  for (const [k, n] of [...byPerson].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  if (skipped.size) {
    console.log("Left for a person to decide:");
    for (const [k, n] of [...skipped].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
  if (dryRun || !plan.length) return;

  const now = new Date();
  await db.transaction(async (tx) => {
    for (const p of plan) {
      const updated = await tx
        .update(customers)
        .set({ [p.seat.idCol]: p.userId, updatedAt: now })
        .where(and(eq(customers.id, p.customerId), isNull(customers[p.seat.idCol])))
        .returning({ id: customers.id });
      if (!updated.length) continue; // somebody filled it meanwhile — theirs stands
      await tx.insert(customerAmChanges).values({
        id: id("amc"),
        customerId: p.customerId,
        role: p.seat.role,
        fromUserId: null,
        fromName: p.text,
        toUserId: p.userId,
        toName: active.get(p.userId)!.name,
        reasonCode: REASON,
        note: NOTE,
        changedById: null,
        changedAt: now,
      });
      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: null,
        action: "customer.seat_linked",
        entityType: "customer",
        entityId: p.customerId,
        beforeState: { [p.seat.idCol]: null, [p.seat.nameCol]: p.text } as never,
        afterState: { [p.seat.idCol]: p.userId, source: "link-named-seats" } as never,
      });
      if (p.kind === "lead") await syncLeadHolders(tx, p.customerId, p.formerHolders);
    }
  });
  console.log("done");
}

main()
  .then(() => db.$client.end())
  .catch(async (e) => {
    console.error(e);
    await db.$client.end();
    process.exit(1);
  });
