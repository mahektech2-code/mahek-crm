import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarCells, monthDays, monthFigures, shiftMonth } from "./attendance-month";

const dates = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"];
const sunday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0;

test("each date says what it was, and a day off is never absent", () => {
  const days = monthDays({
    dates,
    today: "2026-11-06",
    worked: new Map([
      ["2026-11-02", { workDay: "Full Day", workedMin: 492, open: false, lateBeyondGrace: false }],
      ["2026-11-03", { workDay: "Half Day", workedMin: 250, open: false, lateBeyondGrace: true }],
      ["2026-11-01", { workDay: "Extra", workedMin: 190, open: false, lateBeyondGrace: false }],
      ["2026-11-06", { workDay: "", workedMin: 200, open: true, lateBeyondGrace: false }],
    ]),
    holidays: new Map([["2026-11-05", "Guru Nanak Jayanti"]]),
    leave: new Set(["2026-11-04"]),
    workingDay: (d) => !sunday(d),
  });
  assert.deepEqual(
    days.map((d) => d.kind),
    ["extra", "full", "half", "leave", "holiday", "today", "future", "off", "future"],
  );
  assert.equal(days[4].label, "Guru Nanak Jayanti");
  const f = monthFigures(days, "2026-11-06");
  assert.equal(f.present, 1);
  assert.equal(f.workingDaysSoFar, 2);
  assert.deepEqual(f.half, ["2026-11-03"]);
  assert.deepEqual(f.absent, []);
  assert.deepEqual(f.notCounted, { off: 0, holiday: 1, leave: 1 });
  assert.equal(f.extraMin, 190);
  assert.equal(f.late, 1);
  assert.equal(f.averageWorkedMin, 371);
});

test("a past working day with nothing worked is absent", () => {
  const days = monthDays({ dates: ["2026-11-02"], today: "2026-11-10", worked: new Map(), holidays: new Map(), leave: new Set(), workingDay: () => true });
  assert.equal(days[0].kind, "absent");
});

test("the calendar is Monday first, and months shift across the year", () => {
  const cells = calendarCells("2026-11");
  assert.equal(cells.filter((c) => c === null).length, 6, "1 Nov 2026 is a Sunday");
  assert.equal(cells.at(-1), "2026-11-30");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
});
