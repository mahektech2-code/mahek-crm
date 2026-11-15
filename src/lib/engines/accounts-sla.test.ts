import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addWorkingHours,
  escalationLevel,
  judge,
  remarkProblem,
  remindAtFor,
  workingMsBetween,
  type SlaCalendar,
} from "./accounts-sla";

const H = 3_600_000;
/** A local IST wall-clock time as an instant. */
const ist = (s: string) => Date.parse(`${s}+05:30`);

const days: SlaCalendar = {
  clock: "working_days",
  workingDays: [1, 2, 3, 4, 5, 6],
  shiftStart: "09:00",
  shiftEnd: "19:00",
  holidays: new Set(),
};
const office: SlaCalendar = { ...days, clock: "office_hours" };

test("a weekday order is due the same time the next working day", () => {
  // Tue 17 Nov 2026, 11:00 → Wed 11:00
  assert.equal(addWorkingHours(ist("2026-11-17T11:00:00"), 24, days), ist("2026-11-18T11:00:00"));
});

test("Sunday does not count: Saturday 4 pm is due Monday 4 pm", () => {
  assert.equal(addWorkingHours(ist("2026-11-21T16:00:00"), 24, days), ist("2026-11-23T16:00:00"));
});

test("a company holiday does not count either", () => {
  const cal = { ...days, holidays: new Set(["2026-11-18"]) };
  assert.equal(addWorkingHours(ist("2026-11-17T11:00:00"), 24, cal), ist("2026-11-19T11:00:00"));
});

test("something raised on a Sunday starts its clock on Monday morning", () => {
  assert.equal(addWorkingHours(ist("2026-11-22T10:00:00"), 24, days), ist("2026-11-24T00:00:00"));
});

test("office hours: 24 hours of a ten-hour shift is two and a half days", () => {
  // Tue 09:00 → Tue 10h, Wed 10h, Thu 4h → Thu 13:00
  assert.equal(addWorkingHours(ist("2026-11-17T09:00:00"), 24, office), ist("2026-11-19T13:00:00"));
  // Raised after hours: starts next morning
  assert.equal(addWorkingHours(ist("2026-11-17T21:00:00"), 10, office), ist("2026-11-18T19:00:00"));
});

test("working time between two instants skips the non-working day", () => {
  assert.equal(workingMsBetween(ist("2026-11-21T12:00:00"), ist("2026-11-23T12:00:00"), days), 24 * H);
  assert.equal(workingMsBetween(ist("2026-11-23T12:00:00"), ist("2026-11-21T12:00:00"), days), 0);
});

test("judge says overdue only once the deadline has passed", () => {
  const since = ist("2026-11-17T11:00:00");
  assert.equal(judge({ kind: "order", recordId: "o", sinceMs: since }, ist("2026-11-18T10:59:00"), 24, days).overdue, false);
  const v = judge({ kind: "order", recordId: "o", sinceMs: since }, ist("2026-11-18T11:00:00"), 24, days);
  assert.equal(v.overdue, true);
  assert.equal(Math.round(v.waitedHours), 24);
});

test("a calendar with no working day never falls due rather than looping", () => {
  const none = { ...days, workingDays: [] };
  assert.equal(addWorkingHours(ist("2026-11-17T11:00:00"), 24, none), null);
  assert.equal(judge({ kind: "payment", recordId: "p", sinceMs: 0 }, Date.now(), 24, none).overdue, false);
});

test("an escalation is earned every further block of working hours", () => {
  const due = ist("2026-11-18T11:00:00");
  assert.equal(escalationLevel(due, ist("2026-11-19T10:00:00"), 24, days), 0);
  assert.equal(escalationLevel(due, ist("2026-11-19T11:00:00"), 24, days), 1);
  assert.equal(escalationLevel(due, ist("2026-11-20T11:00:00"), 24, days), 2);
  assert.equal(escalationLevel(due, ist("2026-11-20T11:00:00"), 0, days), 0);
});

test("a reason is required, and so is a reminder in the next week", () => {
  const now = ist("2026-11-17T11:00:00");
  assert.match(remarkProblem("later", now + H, now)!, /at least/);
  assert.match(remarkProblem("Waiting for bank statement", null, now)!, /Choose/);
  assert.match(remarkProblem("Waiting for bank statement", now - 1, now)!, /future/);
  assert.match(remarkProblem("Waiting for bank statement", now + 8 * 24 * H, now)!, /at most/);
  assert.equal(remarkProblem("Waiting for bank statement", remindAtFor("1d", now, null), now), null);
  assert.equal(remindAtFor("custom", now, null), null);
});
