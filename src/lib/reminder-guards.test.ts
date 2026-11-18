/**
 * A REMINDER IS DUE ON A REAL DAY, NOT IN THE PAST, AND ONLY ITS PEOPLE MOVE IT.
 *
 * createReminder took any non-empty string as the due date, and
 * rescheduleReminder took any id from anybody signed in. A mistyped year made
 * an already-overdue promise, which is the strongest tier of the Call Log.
 * And a bulk set stopped at the first refusal, leaving the ones before it.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, reminders, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { addDays } from "@/lib/format";
import { today } from "@/lib/recompute";
import { createReminder, rescheduleReminder } from "@/lib/services/worklist-services";
import { createRemindersBulk } from "@/lib/actions/crm";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let TODAY: string;
let priya: typeof users.$inferSelect;
let rakesh: typeof users.$inferSelect;

async function makeUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase()}-${randomUUID().slice(0, 4)}@test.local`, phone: testPhone(), passwordHash: "x", role: "associate", initials: name.slice(0, 2).toUpperCase() })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role: "associate" });
  return row;
}

async function makeCustomer(ownerId: string) {
  const [row] = await db
    .insert(customers)
    .values({ id: id("cus"), name: `Customer ${randomUUID().slice(0, 6)}`, contactPerson: "C", phone: testPhone(), city: "Mumbai", ownerId, salesAmId: ownerId })
    .returning();
  return row;
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/);
});

beforeEach(async () => {
  await db.execute(sql`truncate table reminders, audit_log, notifications, app_access, customers, users, app_settings restart identity cascade`);
  invalidateConfig();
  await seedConfig();
  priya = await makeUser("Priya");
  rakesh = await makeUser("Rakesh");
  setTestUser(priya);
  TODAY = await today();
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("a due date in the past, or not a date at all, is refused", async () => {
  const c = await makeCustomer(priya.id);
  const past = await createReminder({ customerId: c.id, dueDate: addDays(TODAY, -365), note: "Typed 2025" });
  assert.equal(past.ok, false);
  const junk = await createReminder({ customerId: c.id, dueDate: "next tuesday", note: "Typed words" });
  assert.equal(junk.ok, false);
  const fine = await createReminder({ customerId: c.id, dueDate: addDays(TODAY, 2), note: "Ring back" });
  assert.ok(fine.ok);
  const moved = await rescheduleReminder(fine.ok ? fine.data.id : "", addDays(TODAY, -3));
  assert.equal(moved.ok, false, "nor can one be moved into the past");
});

test("somebody else's reminder, on a customer outside their book, cannot be moved", async () => {
  const c = await makeCustomer(priya.id);
  const made = await createReminder({ customerId: c.id, dueDate: addDays(TODAY, 2), note: "Ring back" });
  assert.ok(made.ok);
  const remId = made.ok ? made.data.id : "";

  setTestUser(rakesh);
  await assert.rejects(() => rescheduleReminder(remId, addDays(TODAY, 5)));
  const [row] = await db.select().from(reminders).where(eq(reminders.id, remId));
  assert.equal(row.rescheduleCount, 0);

  setTestUser(priya);
  assert.ok((await rescheduleReminder(remId, addDays(TODAY, 5))).ok);
});

test("a bulk set with one customer out of scope writes none", async () => {
  const mine = [await makeCustomer(priya.id), await makeCustomer(priya.id)];
  const theirs = await makeCustomer(rakesh.id);
  const r = await createRemindersBulk([mine[0].id, theirs.id, mine[1].id], addDays(TODAY, 1), "Stock check");
  assert.equal(r.ok, false);
  assert.equal((await db.select().from(reminders)).length, 0);
});
