/**
 * PERSON IDS FROM STORED NAMES (migration 0353, `npm run jobs -- person-ids-backfill`).
 *
 * The backfill turns a name into an account only through the person
 * directory, and never guesses: a name nobody answers to, or two people
 * answer to, is left unfilled and counted; a leaver resolves to their own
 * switched-off account; a dry run writes nothing; a filled id is never moved.
 *
 * Needs a test database (npm run test:db). It truncates what it touches.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { employees, users } from "@/db/schema";
import { backfillPersonIds } from "./services/person-ids-backfill";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
let row = 1;

async function staff(name: string, opts: { active?: boolean; accounts?: number } = {}) {
  const emp = id("emp");
  await db.insert(employees).values({ id: emp, rowNumber: row++, employeeCode: `EMP-${row}`, name, status: opts.active === false ? "inactive" : "active", raw: {}, rowHash: id("h") });
  const ids: string[] = [];
  for (let i = 0; i < (opts.accounts ?? 1); i++) {
    const [u] = await db
      .insert(users)
      .values({ id: id("usr"), name, email: `${randomUUID().slice(0, 8)}@people.test`, passwordHash: "x", role: "associate", initials: name.slice(0, 2).toUpperCase(), employeeId: emp, active: opts.active !== false })
      .returning({ id: users.id });
    ids.push(u.id);
  }
  return ids;
}

const holderOf = async (cardId: string) =>
  ((await db.execute(sql`select holder_user_id as id from locker_payment_methods where id = ${cardId}`)) as unknown as { id: string | null }[])[0]?.id ?? null;

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Runs only against a test database — `npm run test:db` first.");
  await db.execute(sql`truncate locker_payment_methods, locker_identities, person_name_aliases, employee_reporting, employees, users restart identity cascade`);
});

after(async () => {
  await db.$client.end();
});

test("fills from the directory, leaves what it cannot be sure of, and a dry run writes nothing", async () => {
  const [priya] = await staff("Priya Shah");
  const [left] = await staff("Old Timer", { active: false });
  await staff("Amit Patil");
  await staff("Amit Patil");
  const [keep] = await staff("Someone Else");
  await db.execute(sql`
    insert into locker_payment_methods (id, label, holder, holder_user_id) values
      ('c1', 'Card 1', '  priya   SHAH ', null),
      ('c2', 'Card 2', 'Priya Shah', null),
      ('c3', 'Card 3', 'Old Timer', null),
      ('c4', 'Card 4', 'Amit Patil', null),
      ('c5', 'Card 5', 'Mahek Marketing India', null),
      ('c6', 'Card 6', 'Priya Shah', ${keep})
  `);

  const dry = await backfillPersonIds({ dryRun: true });
  const cards = dry.find((c) => c.column === "locker_payment_methods.holder_user_id")!;
  assert.deepEqual({ filled: cards.filled, unmatched: cards.unmatched, ambiguous: cards.ambiguous }, { filled: 3, unmatched: 1, ambiguous: 1 });
  assert.deepEqual(cards.left.map((l) => [l.name, l.why]).sort(), [["Amit Patil", "several people"], ["Mahek Marketing India", "nobody"]]);
  assert.equal(await holderOf("c1"), null, "the dry run wrote nothing");

  await backfillPersonIds();
  assert.equal(await holderOf("c1"), priya, "any case and spacing, through the directory");
  assert.equal(await holderOf("c2"), priya);
  assert.equal(await holderOf("c3"), left, "a leaver is their own switched-off account");
  assert.equal(await holderOf("c4"), null, "a name two people answer to is nobody's");
  assert.equal(await holderOf("c5"), null, "a holder who is not staff stays text");
  assert.equal(await holderOf("c6"), keep, "an id already there is never moved");

  const again = await backfillPersonIds({ dryRun: true });
  assert.equal(again.find((c) => c.column === "locker_payment_methods.holder_user_id")!.filled, 0, "idempotent");
});
