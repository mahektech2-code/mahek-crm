import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DAILY,
  DEFAULT_POINT_BANDS,
  dailyScore,
  isEmployeeOfMonth,
  noteLength,
  outstandingShare,
  performancePoints,
  pointKind,
  scoredMonth,
  staffMonth,
  type DailyCfg,
  type DailyInput,
  type PointsInput,
} from "./performance";

const cfg: DailyCfg = {
  ...DEFAULT_DAILY,
  weights: { visits: 10, timeCust: 5, noteLen: 5, hours: 10, km: 5, amount: 20, litres: 20, outstanding: 20, tasks: 5 },
  dailyDivisor: 25,
  gstPercent: 18,
};

const base: DailyInput = {
  targets: { visits: 250, km: 1500, litres: 5000, hours: 225, amountPaise: 1_000_000_00 },
  visits: 10,
  timeGivenMin: 50,
  noteChars: 250,
  onFieldMin: 540,
  km: 60,
  amountPaise: 40_000_00,
  litres: 200,
  outstandingPaise: 0,
  fySalesPaise: 10_00_000_00,
  daysSinceFy: 100,
  todos: { total: 0, verified: 0 },
};

test("a day exactly on every target scores the full 100", () => {
  const s = dailyScore(base, cfg);
  assert.equal(s.dailyTargets.visits, 10);
  assert.equal(s.dailyTargets.km, 60);
  assert.equal(s.dailyTargets.amountPaise, 40_000_00);
  assert.equal(s.dailyTargets.litres, 200);
  assert.equal(s.dailyTargets.hours, 9);
  assert.equal(s.total, 100);
  assert.deepEqual(
    s.parts.map((p) => p.got),
    [10, 5, 5, 10, 5, 20, 20, 20, 5],
  );
});

test("visits, time, notes, hours and km are capped; sales and litres are not (A18)", () => {
  const s = dailyScore({ ...base, visits: 30, timeGivenMin: 3000, noteChars: 99999, onFieldMin: 1000, km: 500, amountPaise: 80_000_00, litres: 600 }, cfg);
  const got = Object.fromEntries(s.parts.map((p) => [p.k, p.got]));
  assert.equal(got.visits, 10);
  assert.equal(got.timeCust, 5);
  assert.equal(got.noteLen, 5);
  assert.equal(got.hours, 10);
  assert.equal(got.km, 5);
  assert.equal(got.amount, 40);
  assert.equal(got.litres, 60);
  assert.ok(s.total > 100);
});

test("time and note length are per visit", () => {
  const s = dailyScore({ ...base, visits: 4, timeGivenMin: 10, noteChars: 50 }, cfg);
  assert.equal(s.timePerVisit, 2.5);
  assert.equal(s.notePerVisit, 12.5);
  const got = Object.fromEntries(s.parts.map((p) => [p.k, p.got]));
  assert.equal(got.timeCust, 2.5);
  assert.equal(got.noteLen, 2.5);
  assert.equal(got.visits, 4);
});

test("outstanding bands on average payment days, with GST on total sale", () => {
  assert.equal(outstandingShare(14.9, [15, 30, 45]), 1);
  assert.equal(outstandingShare(15, [15, 30, 45]), 0.5);
  assert.equal(outstandingShare(44, [15, 30, 45]), 0.25);
  assert.equal(outstandingShare(45, [15, 30, 45]), 0);
  /* 1.18 lakh on 11.8 lakh total sale over 200 days = 20 days → half. */
  const s = dailyScore({ ...base, fySalesPaise: 10_00_000_00, outstandingPaise: 1_18_000_00, daysSinceFy: 200 }, cfg);
  assert.equal(s.totalSalePaise, 11_80_000_00);
  assert.equal(s.paymentDays, 20);
  assert.equal(s.parts.find((p) => p.k === "outstanding")!.got, 10);
});

test("nothing sold since the FY start: nothing owed is full, anything owed is zero", () => {
  assert.equal(dailyScore({ ...base, fySalesPaise: 0, outstandingPaise: 0 }, cfg).parts.find((p) => p.k === "outstanding")!.got, 20);
  assert.equal(dailyScore({ ...base, fySalesPaise: 0, outstandingPaise: 5 }, cfg).parts.find((p) => p.k === "outstanding")!.got, 0);
});

test("task component: none that date is full, else verified ÷ total", () => {
  assert.equal(dailyScore(base, cfg).parts.find((p) => p.k === "tasks")!.got, 5);
  assert.equal(dailyScore({ ...base, todos: { total: 4, verified: 1 } }, cfg).parts.find((p) => p.k === "tasks")!.got, 1.25);
});

test("no targets and no visits score nothing rather than dividing by zero", () => {
  const s = dailyScore({ ...base, targets: { visits: null, km: null, litres: null, hours: null, amountPaise: null }, visits: 0 }, cfg);
  const got = Object.fromEntries(s.parts.map((p) => [p.k, p.got]));
  assert.equal(got.visits, 0);
  assert.equal(got.timeCust, 0);
  assert.equal(got.amount, 0);
  assert.ok(Number.isFinite(s.total));
});

test("note length counts characters without spaces and commas (A19)", () => {
  assert.equal(noteLength("Met owner, took order"), 17);
  assert.equal(noteLength(null), 0);
});

test("staff month: hours, punctuality, checklist, to-dos, buddy (A21, A22)", () => {
  const m = staffMonth({
    sales: false,
    days: [
      { durationMin: 480, early: true },
      { durationMin: 240, early: false },
      { durationMin: null, early: true },
    ],
    targetMinutes: [480, 480, 480],
    checklist: [{ status: "Done" }, { status: "N/A" }, { status: "Not Done" }, { status: "" }],
    kpiParts: [],
    todos: [
      { done: true, daysGiven: 4, daysTaken: 1 },
      { done: true, daysGiven: 4, daysTaken: 3 },
      { done: false, daysGiven: 4, daysTaken: null },
    ],
    buddy: [{ done: true }, { done: false }, { done: false }, { done: false }],
  });
  assert.equal(m.workingHoursPct, 50);
  assert.equal(m.punctualityPct, 66.7);
  assert.equal(m.notDoneChecklist, 2);
  assert.equal(m.dailyTaskPct, 50);
  assert.equal(m.avgDaysToComplete, 2);
  assert.equal(m.todoPct, 50);
  assert.equal(m.notDoneTodos, 1);
  assert.equal(m.speed, "Working Speed :- 2 Days Average And 1 Task Not Done");
  assert.equal(m.buddyPct, 25);
  assert.equal(m.notDoneBuddy, 3);
  assert.equal(m.overallPct, Math.round(((50 + 50 + 50 + 66.7) / 4) * 10) / 10);
});

test("staff month for sales: daily task is the four KPI components ÷ 25", () => {
  const m = staffMonth({
    sales: true,
    days: [],
    targetMinutes: [],
    checklist: [],
    kpiParts: [
      { visits: 10, timeCust: 5, noteLen: 5, km: 5 },
      { visits: 5, timeCust: 0, noteLen: 5, km: 0 },
    ],
    todos: [],
    buddy: [],
  });
  assert.equal(m.dailyTaskPct, 70);
  assert.equal(m.todoPct, 100);
  assert.equal(m.buddyPct, null);
});

test("employee of the month at or above the mark", () => {
  assert.equal(isEmployeeOfMonth(90, 90), true);
  assert.equal(isEmployeeOfMonth(89.9, 90), false);
});

test("a row made early in a month scores the previous month", () => {
  assert.equal(scoredMonth("2026-10-05"), "2026-09");
  assert.equal(scoredMonth("2026-10-29"), "2026-10");
  assert.equal(scoredMonth("2026-01-10"), "2025-12");
});

test("position types for the points total (A20)", () => {
  assert.equal(pointKind("Sales"), "Sales");
  assert.equal(pointKind("Field"), "Sales");
  assert.equal(pointKind("OfficeStaff"), "OfficeStaff");
  assert.equal(pointKind("Owner"), "OfficeStaff");
  assert.equal(pointKind("Other"), "Other");
  assert.equal(pointKind(null), "Other");
});

const pts: PointsInput = {
  kind: "Other",
  periodDays: 10,
  attendanceRows: 8,
  earlyRows: 6,
  taggedHolidays: 2,
  durationMin: 8 * 480,
  checklistTotal: 8,
  checklistCleared: 6,
  todosTotal: 2,
  todosDone: 2,
  naReasons: ["Stock audit", ""],
  targets: { visits: 250, km: 1500, litres: 3000, hours: 225, amountPaise: 30_000_00 },
  salesPaise: 10_000_00,
  litres: 500,
  latestOutstandingPaise: 1_000_00,
  salesSinceFinancialPaise: 10_000_00,
  daysSinceFinancial: 200,
  activityMinutes: 400,
  activityDates: 2,
  noteChars: 300,
  kpiVisits: 10,
};
const pcfg = { standardHours: 8, periodDivisor: 30, bands: DEFAULT_POINT_BANDS };

test("points for Other: attendance, punctuality and working hours only (A23: holidays count)", () => {
  const p = performancePoints(pts, pcfg);
  assert.equal(p.attendanceCount, 10);
  assert.equal(p.attendancePoint, 1);
  assert.equal(p.punctualityCount, 8);
  assert.equal(p.punctualityPoint, 0.8);
  assert.equal(p.avgHours, 8);
  assert.equal(p.workingHourPoint, 1);
  assert.equal(p.taskPoint, null);
  assert.equal(p.salesPoint, null);
  assert.equal(p.total, Math.round(((1 + 0.8 + 1) / 3) * 1000) / 1000);
});

test("points for OfficeStaff: the four-point average (A20)", () => {
  const p = performancePoints({ ...pts, kind: "OfficeStaff" }, pcfg);
  assert.equal(p.taskCount, 10);
  assert.equal(p.taskPoint, 0.8);
  assert.equal(p.naText, "Task: 10 Not Applicable Reason Stock audit");
  assert.equal(p.total, Math.round(((0.8 + 1 + 0.8 + 1) / 4) * 1000) / 1000);
});

test("points for Sales: all nine", () => {
  const p = performancePoints({ ...pts, kind: "Sales" }, pcfg);
  /* 30,000 ÷ 30 × 10 days = 10,000 target; 10,000 sold. */
  assert.equal(p.salesPoint, 1);
  assert.equal(p.litrePoint, 0.5);
  /* 1,000 ÷ 10,000 × 200 = 20 days → half. */
  assert.equal(p.outstandingCount, 20);
  assert.equal(p.outstandingPoint, 0.5);
  assert.equal(p.timeGiven, 200);
  assert.equal(p.timePoint, 1);
  assert.equal(p.noteLength, 30);
  assert.equal(p.descriptionPoint, 1);
  const nine = [1, 0.8, 1, 0.8, 1, 0.5, 0.5, 1, 1];
  assert.equal(p.total, Math.round((nine.reduce((a, b) => a + b, 0) / 9) * 1000) / 1000);
});

test("points bands are strict: exactly 180 minutes or 25 characters is the lower band", () => {
  const p = performancePoints({ ...pts, kind: "Sales", activityMinutes: 180, activityDates: 1, noteChars: 250 }, pcfg);
  assert.equal(p.timePoint, 0.5);
  assert.equal(p.descriptionPoint, 0.5);
});
