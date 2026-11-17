import { test } from "node:test";
import assert from "node:assert/strict";
import { dayFigures, decideCheckIn, decideCheckOut, minutesBetween, timeRemark } from "./attendance";

const cfg = { graceMinutes: 30, fullDayPercent: 60, qrGraceMinutes: 0, qrFullDayPercent: 70 };
const day = { date: "2026-10-01", checkIn: "09:40", checkOut: "18:00", stoppageMin: 0, officialIn: "09:30", officialOut: "18:30", targetMin: 540, method: "geo" };

test("a day's figures: late inside the grace, worked against target", () => {
  const f = dayFigures(day, cfg, "2026-10-01");
  assert.equal(f.lateMin, 10);
  assert.equal(f.lateBeyondGrace, false);
  assert.equal(f.lateTxt, "Late 10 min");
  assert.equal(f.workedMin, 500);
  assert.equal(f.pct, 93);
  assert.equal(f.workDay, "Full Day");
  assert.equal(f.current, "Present");
});

test("under the full-day percent is a half day; stoppage comes off", () => {
  const f = dayFigures({ ...day, checkOut: "14:00", stoppageMin: 60 }, cfg, "2026-10-01");
  assert.equal(f.workedMin, 200);
  assert.equal(f.workDay, "Half Day");
});

test("no check-out: on working today, no check-out on an earlier day", () => {
  assert.equal(dayFigures({ ...day, checkOut: null }, cfg, "2026-10-01").current, "Working");
  assert.equal(dayFigures({ ...day, checkOut: null }, cfg, "2026-10-02").current, "No check-out");
  assert.equal(dayFigures({ ...day, checkOut: null }, cfg, "2026-10-02").workDay, "");
});

test("QR days use their own grace and a strict full-day threshold", () => {
  const f = dayFigures({ ...day, method: "qr", checkOut: "15:58" }, cfg, "2026-10-01");
  assert.equal(f.lateBeyondGrace, true);
  assert.equal(f.pct, 70);
  assert.equal(f.workDay, "Half Day");
});

test("the remark says how far inside or past the grace the check-in was", () => {
  const early = dayFigures({ ...day, checkIn: "09:20" }, cfg, "2026-10-01");
  assert.equal(timeRemark(early, "Priya"), "On time, with 40 minutes to spare — well done, Priya.");
  const late = dayFigures({ ...day, checkIn: "10:15" }, cfg, "2026-10-01");
  assert.equal(timeRemark(late, "Priya"), "15 minutes past the grace period today, Priya.");
});

const base = { alreadyToday: false, distanceM: 50, officeHasPin: true, officeName: "Thane", radiusM: 200, privileged: false, privilegedRangeM: 9000, officialIn: "09:30", now: "09:45", graceMinutes: 30, name: "Priya" };

test("check-in: only already refuses; location and lateness are never a gate", () => {
  assert.deepEqual(decideCheckIn(base), { ok: true });
  assert.equal((decideCheckIn({ ...base, alreadyToday: true }) as { reason: string }).reason, "already");
  assert.deepEqual(decideCheckIn({ ...base, distanceM: null }), { ok: true });
  assert.deepEqual(decideCheckIn({ ...base, officeHasPin: false }), { ok: true });
  assert.deepEqual(decideCheckIn({ ...base, distanceM: 3000 }), { ok: true });
  assert.deepEqual(decideCheckIn({ ...base, now: "10:01" }), { ok: true });
  assert.deepEqual(decideCheckIn({ ...base, now: "17:45" }), { ok: true });
});

test("check-in: HR is never late", () => {
  assert.deepEqual(decideCheckIn({ ...base, privileged: true, distanceM: 8000, now: "11:00" }), { ok: true });
});

test("check-out: never refused for location", () => {
  assert.deepEqual(decideCheckOut({ ...base, officeHasPin: false }), { ok: true });
  assert.deepEqual(decideCheckOut({ ...base, distanceM: 3000 }), { ok: true });
  assert.deepEqual(decideCheckOut({ ...base, distanceM: null }), { ok: true });
});

test("minutesBetween refuses out before in", () => {
  assert.equal(minutesBetween("09:00", "17:30"), 510);
  assert.equal(minutesBetween("17:30", "09:00"), null);
  assert.equal(minutesBetween(null, "09:00"), null);
});
