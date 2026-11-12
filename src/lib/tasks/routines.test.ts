import test from "node:test";
import assert from "node:assert/strict";
import { normaliseRoutine, occurrenceOn, routineProblems, scheduleWords, weekdayOf, windowWords, type RoutineSchedule } from "./routines";

const base: RoutineSchedule = { frequency: "daily", weekdays: [1, 2, 3, 4, 5, 6], dayOfMonth: null, completeByDay: null, startsOn: "2026-11-01", active: true };

test("the weekday is read off the date itself", () => {
  assert.equal(weekdayOf("2026-11-12"), 4); // a Thursday
  assert.equal(weekdayOf("2026-11-15"), 0); // a Sunday
});

test("a daily routine runs on its weekdays and not on the others", () => {
  assert.deepEqual(occurrenceOn(base, "2026-11-12"), { dueDate: "2026-11-12" });
  assert.equal(occurrenceOn(base, "2026-11-15"), null);
});

test("nothing before it starts, and nothing while it is paused", () => {
  assert.equal(occurrenceOn({ ...base, startsOn: "2026-11-13" }, "2026-11-12"), null);
  assert.equal(occurrenceOn({ ...base, active: false }, "2026-11-12"), null);
});

test("a monthly routine appears on its day and is due by its done-by day", () => {
  const m: RoutineSchedule = { ...base, frequency: "monthly", weekdays: [], dayOfMonth: 25, completeByDay: 30 };
  assert.deepEqual(occurrenceOn(m, "2026-11-25"), { dueDate: "2026-11-30" });
  assert.equal(occurrenceOn(m, "2026-11-24"), null);
  assert.deepEqual(occurrenceOn({ ...m, completeByDay: null }, "2026-11-25"), { dueDate: "2026-11-25" });
});

test("the 31st lands on a short month's last day, and its done-by day is held there too", () => {
  const m: RoutineSchedule = { ...base, startsOn: "2026-01-01", frequency: "monthly", weekdays: [], dayOfMonth: 31, completeByDay: null };
  assert.deepEqual(occurrenceOn(m, "2026-02-28"), { dueDate: "2026-02-28" });
  assert.equal(occurrenceOn(m, "2026-11-29"), null);
  assert.deepEqual(occurrenceOn(m, "2026-11-30"), { dueDate: "2026-11-30" });
  const late: RoutineSchedule = { ...m, dayOfMonth: 28, completeByDay: 31 };
  assert.deepEqual(occurrenceOn(late, "2026-02-28"), { dueDate: "2026-02-28" });
});

test("schedules read as a person would say them", () => {
  assert.equal(scheduleWords(base), "Mon to Sat");
  assert.equal(scheduleWords({ ...base, weekdays: [0, 1, 2, 3, 4, 5, 6] }), "Every day");
  assert.equal(scheduleWords({ ...base, frequency: "weekly", weekdays: [5, 2] }), "Every Tue and Fri");
  assert.equal(scheduleWords({ ...base, frequency: "weekly", weekdays: [6] }), "Every Sat");
  assert.equal(scheduleWords({ ...base, frequency: "monthly", weekdays: [], dayOfMonth: 1, completeByDay: 3 }), "Monthly on the 1st, done by the 3rd");
  assert.equal(scheduleWords({ ...base, frequency: "monthly", weekdays: [], dayOfMonth: 22, completeByDay: null }), "Monthly on the 22nd");
  assert.equal(windowWords("14:00", "16:30"), "2 PM to 4:30 PM");
  assert.equal(windowWords(null, "16:00"), "by 4 PM");
  assert.equal(windowWords(null, null), "");
});

test("a routine is checked field by field", () => {
  const ok = { title: "Bank statement", app: "tasks", priority: "normal", frequency: "daily", weekdays: [1], dayOfMonth: null, completeByDay: null, startTime: "14:00", dueTime: "16:00" };
  assert.deepEqual(routineProblems(ok), []);
  assert.equal(routineProblems({ ...ok, weekdays: [] })[0].field, "weekdays");
  // Hire is closed to new routines, but one already filed there keeps it on an edit.
  assert.equal(routineProblems({ ...ok, app: "hire" })[0].field, "app");
  assert.deepEqual(routineProblems({ ...ok, app: "hire" }, { keepApp: "hire" }), []);
  assert.equal(routineProblems({ ...ok, dueTime: "13:00" })[0].field, "dueTime");
  assert.equal(routineProblems({ ...ok, frequency: "monthly", dayOfMonth: null })[0].field, "dayOfMonth");
  assert.equal(routineProblems({ ...ok, frequency: "monthly", dayOfMonth: 10, completeByDay: 10 })[0].field, "completeByDay");
  assert.deepEqual(routineProblems({ ...ok, frequency: "monthly", weekdays: [], dayOfMonth: 10, completeByDay: 12 }), []);
});

test("saving keeps only what the frequency uses", () => {
  const m = normaliseRoutine({ title: " GST ", app: "tasks", priority: "high", frequency: "monthly", weekdays: [1, 2], dayOfMonth: 18, completeByDay: 21, startTime: "", dueTime: null, note: "  " });
  assert.deepEqual([m.title, m.weekdays, m.dayOfMonth, m.startTime, m.note], ["GST", [], 18, null, null]);
  const d = normaliseRoutine({ title: "x", app: "tasks", priority: "normal", frequency: "daily", weekdays: [3, 1, 3], dayOfMonth: 5, completeByDay: 9, startTime: null, dueTime: null });
  assert.deepEqual([d.weekdays, d.dayOfMonth, d.completeByDay], [[1, 3], null, null]);
});
