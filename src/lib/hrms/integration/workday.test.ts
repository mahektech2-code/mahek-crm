/**
 * The workday clock against a real database, through the real handlers:
 * punch in, a break and back, an idle hour turned into a break and claimed as
 * work, the manager's decision, punching out, and a holiday worked as extra.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, employeeReporting, employees, hrmsAttendance, hrmsHolidays, hrmsOffices, hrmsWorkdayClaims, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { hrmsContext } from "@/lib/hrms/access";
import { hrmsCheckIn, hrmsCheckOut } from "@/lib/actions/hrms-checkin";
import { resumeWork, startBreak, decideClaim, beat } from "@/lib/hrms/workday-ops";
import { lockApplies, sessionsOf, settledToday, workdayState } from "@/lib/hrms/services/workday";
import { attendanceRows } from "@/lib/hrms/services/attendance";
import { phaseOf } from "@/lib/hrms/engines/workday";
import { today } from "@/lib/hrms/server";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const PIN = { lat: 19.1197, lng: 72.8468 };
const MIN = 60_000;

async function person(name: string, office: string) {
  const [e] = await db
    .insert(employees)
    .values({
      id: id("emp"),
      rowNumber: 0,
      employeeCode: `W-${Math.floor(Math.random() * 1e6)}`,
      name,
      officeName: office,
      position: "Telecaller",
      department: "Office",
      status: "active",
      raw: {},
      rowHash: "wd",
      sheetStatus: "present",
      source: "hrms",
      netSalaryPaise: 2000000,
      gender: "Female",
    })
    .returning();
  return e;
}

async function account(name: string, emp: { id: string }, level: "associate" | "manager" = "associate") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\s/g, ".")}.${randomUUID().slice(0, 6)}@wd.test`, phone: testPhone(), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase(), employeeId: emp.id })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "hrms", role: level });
  return u;
}

async function as(u: typeof users.$inferSelect) {
  setTestUser(u);
  return hrmsContext();
}

/** Move a day's stretches back in time, as if it had been running since then. */
async function backdate(employeeId: string, minutes: number, lastActivityMinutesAgo: number) {
  const [row] = await db.select().from(hrmsAttendance).where(eq(hrmsAttendance.employeeId, employeeId));
  const s = sessionsOf(row).map((x) => ({ ...x, in: x.in - minutes * MIN, out: x.out == null ? null : x.out - minutes * MIN }));
  await db.update(hrmsAttendance).set({ sessions: s, lastActivityAt: new Date(Date.now() - lastActivityMinutesAgo * MIN) }).where(eq(hrmsAttendance.id, row.id));
}

describe("the workday clock", () => {
  let office: string;
  before(async () => {
    await db.execute(sql`truncate hrms_workday_claims, hrms_attendance, hrms_holidays, employee_reporting, hrms_offices cascade`);
    office = `Andheri ${randomUUID().slice(0, 6)}`;
    await db.insert(hrmsOffices).values({ id: id("hoff"), name: office, lat: PIN.lat, lng: PIN.lng, radiusM: 200 });
  });
  after(async () => {
    setTestUser(null);
    await db.$client.end();
  });

  test("punch in, a break and back: two stretches, and the gap is not work", async () => {
    const e = await person("Asha Break", office);
    const ctx = await as(await account("Asha Break", e));
    const r = await hrmsCheckIn({ ...PIN, photoId: null, code: null });
    assert.ok(r.ok && !r.data.refusal, JSON.stringify(r));
    let row = (await settledToday(e.id))!;
    assert.equal(phaseOf(sessionsOf(row)), "working");
    assert.equal(row.presentMin, 480, "the settings' 8 hours are stamped on the day");

    assert.ok((await startBreak(ctx, "Lunch")).ok);
    row = (await settledToday(e.id))!;
    assert.equal(phaseOf(sessionsOf(row)), "break");
    assert.equal(row.checkOut, null, "a day on a break is still open on the register");

    assert.ok((await resumeWork(ctx, null)).ok);
    row = (await settledToday(e.id))!;
    assert.equal(sessionsOf(row).length, 2);
    assert.equal(phaseOf(sessionsOf(row)), "working");
  });

  test("an idle half hour is a break from the last activity; claimed as work, the manager decides", async () => {
    const boss = await person("Meera Boss", office);
    const e = await person("Ravi Idle", office);
    await db.insert(employeeReporting).values({ id: id("erep"), employeeId: e.id, managerId: boss.id });
    const bossUser = await account("Meera Boss", boss, "manager");
    const u = await account("Ravi Idle", e);
    let ctx = await as(u);
    assert.ok((await hrmsCheckIn({ ...PIN, photoId: null, code: null })).ok);
    /* Working for three hours, nothing for the last forty minutes. */
    await backdate(e.id, 180, 40);
    const row = (await settledToday(e.id))!;
    const s = sessionsOf(row);
    assert.equal(phaseOf(s), "auto_break");
    assert.ok(Math.abs(s[0].out! - (Date.now() - 40 * MIN)) < 5_000, "the break is dated from the last activity");

    /* A beat during a break is not evidence of work. */
    await beat(ctx);
    assert.equal(phaseOf(sessionsOf((await settledToday(e.id))!)), "auto_break");

    ctx = await as(u);
    assert.ok((await resumeWork(ctx, { category: "On a call", note: "Long call with a customer" })).ok);
    const [claim] = await db.select().from(hrmsWorkdayClaims).where(eq(hrmsWorkdayClaims.employeeId, e.id));
    assert.equal(claim.status, "pending");
    assert.equal(claim.kind, "auto_break");

    /* Nobody decides their own claim. */
    assert.equal((await decideClaim(ctx, claim.id, true, "")).ok, false);

    const before = (await settledToday(e.id))!.stoppageMin;
    const bctx = await as(bossUser);
    assert.ok((await decideClaim(bctx, claim.id, true, "")).ok);
    const afterRow = (await db.select().from(hrmsAttendance).where(eq(hrmsAttendance.employeeId, e.id)))[0];
    assert.ok(afterRow.stoppageMin < before, "an approved claim comes off the breaks");
  });

  test("an hour idle closes the day at the last activity, and punching out ends a running day", async () => {
    const e = await person("Sunil Out", office);
    const u = await account("Sunil Out", e);
    await as(u);
    assert.ok((await hrmsCheckIn({ ...PIN, photoId: null, code: null })).ok);
    await backdate(e.id, 120, 65);
    const row = (await settledToday(e.id))!;
    assert.equal(phaseOf(sessionsOf(row)), "auto_out");
    assert.ok(row.checkOut, "a closed day carries its last out on the register");
    /* And back again, from the office. */
    const again = await hrmsCheckIn({ ...PIN, photoId: null, code: null });
    assert.ok(again.ok && !again.data.refusal, JSON.stringify(again));
    assert.equal(phaseOf(sessionsOf((await settledToday(e.id))!)), "working");
    const out = await hrmsCheckOut({ ...PIN, photoId: null });
    assert.ok(out.ok && !out.data.refusal, JSON.stringify(out));
    const day = (await attendanceRows({ employeeIds: [e.id], from: today(), to: today() }))[0];
    assert.equal(day.fig.workDay, "Absent", "under the half-day hours the day is Absent");
  });

  test("a holiday worked is extra work and never locked", async () => {
    const e = await person("Hema Holiday", office);
    const u = await account("Hema Holiday", e);
    await db.insert(hrmsHolidays).values({ id: id("hhol"), date: today(), category: "Festival", name: "Test festival", tagged: "All employees", taggedEmployeeIds: [] });
    const ctx = await as(u);
    const s = await workdayState(ctx);
    assert.equal(s.offDay, "holiday");
    assert.equal(lockApplies({ lockEnabled: true, subject: true, exempt: null, offDay: s.offDay, onHandset: false, phase: "none" }), false);
    assert.ok((await hrmsCheckIn({ ...PIN, photoId: null, code: null })).ok);
    assert.ok((await hrmsCheckOut({ ...PIN, photoId: null })).ok);
    const day = (await attendanceRows({ employeeIds: [e.id], from: today(), to: today() }))[0];
    assert.equal(day.offDay, "holiday");
    assert.equal(day.fig.workDay, "Extra", "extra work is counted by no payroll figure");
    await db.delete(hrmsHolidays);
  });

  test("the lock: only working is open, and only when it is switched on", () => {
    const base = { lockEnabled: true, subject: true, exempt: null, offDay: null, onHandset: false };
    assert.equal(lockApplies({ ...base, phase: "none" }), true);
    assert.equal(lockApplies({ ...base, phase: "working" }), false);
    assert.equal(lockApplies({ ...base, phase: "break" }), true);
    assert.equal(lockApplies({ ...base, phase: "done" }), true);
    assert.equal(lockApplies({ ...base, lockEnabled: false, phase: "none" }), false);
    assert.equal(lockApplies({ ...base, exempt: "platform-admin", phase: "none" }), false);
    assert.equal(lockApplies({ ...base, onHandset: true, phase: "none" }), false);
  });
});
