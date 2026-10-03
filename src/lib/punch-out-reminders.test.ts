import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { mbosAttendanceDays, notifications, users } from "@/db/schema";
import { invalidateConfig, seedConfig, updateSettings } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { minuteOfDay } from "@/lib/engines/punch-out-reminders";
import { sendPunchOutReminders } from "@/lib/services/punch-out-reminder-service";

/**
 * The server's end-of-day punch-out reminder, against a real database.
 *
 * The rule for WHEN is pinned by the engine's own tests. What only a database
 * can show is the half that sends: that a day still open is found, that the
 * claim on `punch_out_reminders` stops a later pass sending the same reminder
 * again, and that a day already closed is left alone. The prompt hour is set to
 * midnight so the tests do not depend on what time CI happens to run.
 */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
let salesman: typeof users.$inferSelect;

before(() => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table mbos_attendance_days, notifications, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  [salesman] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name: "Mahesh",
      email: "mahesh@test.local",
      phone: "9820011007",
      passwordHash: "x",
      role: "associate",
      initials: "MP",
    })
    .returning();
});

after(() => db.$client.end());

async function settings(promptHour: number, secondAfterMinutes: number) {
  const r = await updateSettings(
    [
      { key: "mbos.attendance.punchOutPromptHour", value: promptHour },
      { key: "mbos.attendance.punchOutSecondReminderMinutes", value: secondAfterMinutes },
    ],
    salesman.id,
  );
  assert.ok(r.ok, "the settings were refused");
  invalidateConfig();
}

async function dayFor(open: boolean) {
  const [row] = await db
    .insert(mbosAttendanceDays)
    .values({
      id: id("att"),
      userId: salesman.id,
      day: await today(),
      checkInAt: new Date(Date.now() - 8 * 3_600_000),
      checkOutAt: open ? null : new Date(Date.now() - 60_000),
    })
    .returning();
  return row;
}

const sent = () => db.select().from(notifications).where(eq(notifications.userId, salesman.id));

test("a day still open is reminded once, and a second pass sends nothing", async () => {
  await settings(0, 0);
  const day = await dayFor(true);

  const first = await sendPunchOutReminders();
  assert.equal(first.recordsAffected, 1);
  const rows = await sent();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Still punched in");

  const [after] = await db.select().from(mbosAttendanceDays).where(eq(mbosAttendanceDays.id, day.id));
  assert.equal(after.punchOutReminders, 1);

  const again = await sendPunchOutReminders();
  assert.equal(again.recordsAffected, 0, "the same reminder was sent twice");
  assert.equal((await sent()).length, 1);
});

test("a day already punched out of is left alone", async () => {
  await settings(0, 0);
  await dayFor(false);
  const out = await sendPunchOutReminders();
  assert.equal(out.recordsAffected, 0);
  assert.equal((await sent()).length, 0);
});

test("the second reminder follows the first and says the later thing", async (t) => {
  if (minuteOfDay(Date.now()) < 2) return t.skip("too close to midnight for a one-minute gap");
  await settings(0, 0);
  await dayFor(true);
  await sendPunchOutReminders();

  await settings(0, 1);
  const out = await sendPunchOutReminders();
  assert.equal(out.recordsAffected, 1);
  const titles = (await sent()).map((r) => r.title).sort();
  assert.deepEqual(titles, ["Still punched in", "You have not punched out yet"]);
});
