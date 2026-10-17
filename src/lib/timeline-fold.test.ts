/**
 * A REMINDER A CALL SET IS SHOWN ON THAT CALL, NOT BESIDE IT.
 *
 * Saving a call with a callback writes the call and the reminder it raised,
 * and the reminder carries the call's note word for word — so the customer
 * record listed the same sentence twice, a minute apart, and it read as a call
 * saved twice (reported on NAKODA PAINTS). The All view folds the reminder onto
 * its call's line; a reminder set on its own keeps its row; the Reminder filter
 * still lists every reminder; and the All pill counts what the All view lists.
 *
 *   DATABASE_URL=...mahekone_test npx tsx --conditions=react-server \
 *     --test src/lib/timeline-fold.test.ts
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { calls, customers, reminders, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { customerTimeline, customerTimelineCounts } from "@/lib/queries";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let priya: typeof users.$inferSelect;
let customerId: string;

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

after(async () => {
  await db.$client.end();
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      audit_log, notifications, reminders, calls, app_access, sessions,
      customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  [priya] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name: "Priya",
      email: `priya_${randomUUID().slice(0, 6)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: "associate",
      initials: "PR",
    })
    .returning();
  setTestUser(priya);
  customerId = id("cus");
  await db.insert(customers).values({
    id: customerId,
    name: "Nakoda Paints",
    contactPerson: "Karna",
    phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
    city: "Jaipur",
    ownerId: priya.id,
    salesAmId: priya.id,
  });
});

async function call(note: string, at: Date) {
  const callId = id("ixn");
  await db.insert(calls).values({
    id: callId,
    customerId,
    userId: priya.id,
    outcome: "payment_promised",
    notes: note,
    startedAt: at,
  });
  return callId;
}

async function reminder(note: string, callId: string | null, due = "2026-10-03") {
  await db.insert(reminders).values({
    id: id("rem"),
    customerId,
    createdByUserId: priya.id,
    assignedUserId: priya.id,
    callId,
    dueDate: due,
    note,
    type: "call_back",
  });
}

describe("a call's own reminder is folded onto the call", () => {
  test("the All view lists the call once, carrying the callback", async () => {
    const c = await call("Payment will be made on Saturday.", new Date("2026-10-01T13:48:00Z"));
    await reminder("Payment will be made on Saturday.", c);

    const page = await customerTimeline(customerId);
    assert.deepEqual(
      page.entries.map((e) => e.kind),
      ["Call"],
      "the reminder the call set came back as a row of its own",
    );
    assert.match(page.entries[0].meta ?? "", /callback 03 Oct, pending/);
    assert.doesNotMatch(
      page.entries[0].meta ?? "",
      /Saturday/,
      "a note identical to the call's was repeated on the same line",
    );

    const counts = await customerTimelineCounts(customerId);
    assert.equal(counts.all, 1, "the All pill counted a row the All view does not list");
    assert.equal(counts.Reminder, 1, "the Reminder pill must still count every reminder");
  });

  test("a reminder note that says more than the call is kept beside it", async () => {
    const c = await call("He will pay on Saturday.", new Date("2026-10-01T13:48:00Z"));
    await reminder("Promised ₹40,000. He will pay on Saturday.", c);

    const [entry] = (await customerTimeline(customerId)).entries;
    assert.match(entry.meta ?? "", /Promised ₹40,000/);
  });

  test("a reminder set on its own keeps its row", async () => {
    await call("Hung up.", new Date("2026-10-01T10:00:00Z"));
    await reminder("Ring after Diwali", null, "2026-11-05");

    const kinds = (await customerTimeline(customerId)).entries.map((e) => e.kind).sort();
    assert.deepEqual(kinds, ["Call", "Reminder"]);
    assert.equal((await customerTimelineCounts(customerId)).all, 2);
  });

  test("the Reminder filter still lists every reminder, folded or not", async () => {
    const c = await call("Payment will be made on Saturday.", new Date("2026-10-01T13:48:00Z"));
    await reminder("Payment will be made on Saturday.", c);
    await reminder("Ring after Diwali", null, "2026-11-05");

    const page = await customerTimeline(customerId, { kind: "Reminder" });
    assert.equal(page.entries.length, 2);
  });
});
