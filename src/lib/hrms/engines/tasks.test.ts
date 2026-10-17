import { test } from "node:test";
import assert from "node:assert/strict";
import {
  averageDaysTaken,
  buddySuggestions,
  checkTemplate,
  checklistBucket,
  daysGiven,
  daysTaken,
  expiredMessage,
  monthlyTemplates,
  monthlyTodoDates,
  sameWeek,
  storedWeekdays,
  taskEodMessage,
  templatesForDay,
  timeDifference,
  todoExpired,
  todoOverdue,
  todoTab,
  waDigits,
} from "./tasks";

const tpl = (task: string, frequency: string, weekdays: string[]) => ({ task, frequency, weekdays });

/* 2026-10-01 is a Thursday. */
test("Take my task copies the non-Monthly templates for the date's weekday", () => {
  const ts = [tpl("A", "Daily", ["Thursday", "Friday"]), tpl("B", "Weekly", ["Monday"]), tpl("C", "Monthly", ["Thursday"]), tpl("D", "Weekly", ["Thursday"])];
  assert.deepEqual(templatesForDay(ts, "2026-10-01").map((t) => t.task), ["A", "D"]);
  assert.deepEqual(monthlyTemplates(ts).map((t) => t.task), ["C"]);
});

test("a Daily template with no weekdays runs every day; Monthly keeps none", () => {
  assert.equal(storedWeekdays("Daily", []).length, 7);
  assert.deepEqual(storedWeekdays("Weekly", ["Friday", "Monday"]), ["Monday", "Friday"]);
  assert.deepEqual(storedWeekdays("Monthly", ["Monday"]), []);
});

test("Take monthly task dates are clamped to the month's length", () => {
  assert.deepEqual(monthlyTodoDates("2026-10", 5, 10), { forDate: "2026-10-05", tillDate: "2026-10-10" });
  assert.deepEqual(monthlyTodoDates("2026-02", 30, 31), { forDate: "2026-02-28", tillDate: "2026-02-28" });
  assert.deepEqual(monthlyTodoDates("2026-09", 31, null), { forDate: "2026-09-30", tillDate: null });
});

test("the template rules speak the source's words", () => {
  const base = { category: "Important", startTime: "10:00", endTime: "10:30", weekdays: [] as string[] };
  assert.equal(checkTemplate({ ...base, frequency: "Monthly", dayOfMonth: 10, beforeDay: 10 })?.message, "The complete-before day must be later than day 10");
  assert.equal(checkTemplate({ ...base, frequency: "Monthly", dayOfMonth: 10, beforeDay: 12 }), null);
  assert.equal(checkTemplate({ ...base, frequency: "Monthly", dayOfMonth: null, beforeDay: null })?.field, "dom");
  assert.equal(checkTemplate({ ...base, frequency: "Weekly", dayOfMonth: null, beforeDay: null })?.field, "weekdays");
  assert.equal(checkTemplate({ ...base, frequency: "Daily", dayOfMonth: null, beforeDay: null }), null);
  assert.equal(checkTemplate({ ...base, frequency: "Daily", endTime: "09:00", dayOfMonth: null, beforeDay: null })?.field, "end");
});

test("a to-do expires the day after its till date, never with none", () => {
  assert.equal(todoExpired("2026-10-01", "2026-10-01"), false);
  assert.equal(todoExpired("2026-10-01", "2026-10-02"), true);
  assert.equal(todoExpired(null, "2030-01-01"), false);
  assert.equal(expiredMessage("Send stock report", "2026-09-30"), "“Send stock report” was due by 30 Sep 2026 and has expired, so it can no longer be marked");
});

test("overdue: open and past the till date, or past the for date without one", () => {
  assert.equal(todoOverdue({ status: "Open", forDate: "2026-09-20", tillDate: "2026-09-30" }, "2026-10-01"), true);
  assert.equal(todoOverdue({ status: "Open", forDate: "2026-09-20", tillDate: "2026-10-01" }, "2026-10-01"), false);
  assert.equal(todoOverdue({ status: "Open", forDate: "2026-09-30", tillDate: null }, "2026-10-01"), true);
  assert.equal(todoOverdue({ status: "Done", forDate: "2026-09-20", tillDate: "2026-09-21" }, "2026-10-01"), false);
});

test("days taken, days given and the monthly average", () => {
  assert.equal(daysTaken("2026-09-20", "2026-09-23"), 3);
  assert.equal(daysTaken("2026-09-20", null), null);
  assert.equal(daysGiven("2026-09-20", "2026-09-25"), 5);
  assert.equal(daysGiven("2026-09-20", null), 10);
  const done = [
    { toEmployeeId: "e1", forDate: "2026-09-01", doneOn: "2026-09-03" },
    { toEmployeeId: "e1", forDate: "2026-09-10", doneOn: "2026-09-11" },
    { toEmployeeId: "e1", forDate: "2026-08-30", doneOn: "2026-10-01" },
    { toEmployeeId: "e2", forDate: "2026-09-01", doneOn: "2026-09-09" },
  ];
  assert.equal(averageDaysTaken(done, "e1", "2026-09"), 1.5);
  assert.equal(averageDaysTaken(done, "e1", "2026-07"), null);
});

test("to-do tabs", () => {
  assert.equal(todoTab("Open", "Pending"), "Open");
  assert.equal(todoTab("Done", ""), "To verify");
  assert.equal(todoTab("Done", "Verified"), "History");
});

test("the checklist week runs Sunday to Saturday", () => {
  assert.equal(sameWeek("2026-09-27", "2026-10-03"), true);
  assert.equal(sameWeek("2026-09-26", "2026-09-27"), false);
  assert.equal(checklistBucket("2026-10-01", "", "2026-10-01"), "Today");
  assert.equal(checklistBucket("2026-09-28", "", "2026-10-01"), "Not done this week");
  assert.equal(checklistBucket("2026-09-28", "Done", "2026-10-01"), "Earlier");
  assert.equal(checklistBucket("2026-09-26", "", "2026-10-01"), "Earlier");
});

test("time difference is working time minus end time", () => {
  assert.equal(timeDifference("10:45", "10:30"), 15);
  assert.equal(timeDifference("10:15", "10:30"), -15);
  assert.equal(timeDifference(null, "10:30"), null);
});

test("buddy suggestions leave out what was already shared today", () => {
  const ts = [tpl("Dispatch list", "Daily", ["Thursday"]), tpl("Bank", "Daily", ["Thursday"]), tpl("Stock", "Weekly", ["Monday"])];
  assert.deepEqual(buddySuggestions(ts, "2026-10-01", ["dispatch list"]), ["Bank"]);
});

test("the Task EOD message is the spec's format, five at most", () => {
  const checklist = [
    { task: "T1", status: "Done", naReason: null, remark: null },
    { task: "T2", status: "", naReason: null, remark: null },
    ...Array.from({ length: 6 }, (_, i) => ({ task: `N${i + 1}`, status: "Not applicable", naReason: `R${i + 1}`, remark: null })),
  ];
  const todos = [
    { task: "Late one", status: "Open", forDate: "2026-10-01", toEmployeeId: "e1" },
    { task: "Earlier", status: "Open", forDate: "2026-09-30", toEmployeeId: "e1" },
    { task: "Future", status: "Open", forDate: "2026-10-05", toEmployeeId: "e1" },
    { task: "Done", status: "Done", forDate: "2026-10-01", toEmployeeId: "e1" },
    { task: "Other", status: "Open", forDate: "2026-10-01", toEmployeeId: "e2" },
  ];
  const msg = taskEodMessage({ name: "Pooja Joshi", employeeId: "e1", today: "2026-10-01", checklist, todos });
  assert.equal(
    msg,
    [
      "*📝 Task EOD - Pooja Joshi*",
      "📅 *Date:* 1 Oct 2026",
      "--------------------------------",
      "📊 *Summary:*",
      "🔹 *Total tasks:* 8",
      "✅ *Completed:* 1",
      "⏳ *Pending:* 1",
      "🚫 *Not applicable:* 6",
      "--------------------------------",
      "🚫 *Not applicable tasks:*",
      "*Task:* 1. N1\n2. N2\n3. N3\n4. N4\n5. N5",
      "*Reason:* 1. R1\n2. R2\n3. R3\n4. R4\n5. R5",
      "--------------------------------",
      "⚠ *Overdue and pending to-dos:*",
      "1. Late one",
    ].join("\n"),
  );
  assert.equal(waDigits("+91 98228 24973"), "919822824973");
});
