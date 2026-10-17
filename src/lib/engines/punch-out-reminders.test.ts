import { test } from "node:test";
import assert from "node:assert/strict";

import { minuteOfDay, remindersDue } from "./punch-out-reminders";

/* An IST wall clock on 2026-10-03, as the UTC instant it is. */
const ist = (h: number, m = 0) => Date.UTC(2026, 9, 3, h, m) - 330 * 60_000;
const due = (h: number, m = 0, promptHour = 18, secondAfterMinutes = 90) =>
  remindersDue({ nowMs: ist(h, m), promptHour, secondAfterMinutes });

test("the clock is read in Asia/Kolkata, not UTC", () => {
  assert.equal(minuteOfDay(ist(18, 7)), 18 * 60 + 7);
  assert.equal(minuteOfDay(ist(0, 10)), 10);
});

test("nothing before the prompt hour", () => {
  assert.equal(due(17, 59), 0);
});

test("the first from the prompt hour", () => {
  assert.equal(due(18, 0), 1);
  assert.equal(due(19, 29), 1);
});

test("the second once its gap has passed", () => {
  assert.equal(due(19, 30), 2);
  assert.equal(due(23, 0), 2);
});

test("zero minutes turns the second off", () => {
  assert.equal(due(22, 0, 18, 0), 1);
});

test("a second that would fall past midnight is never due", () => {
  assert.equal(due(23, 59, 23, 120), 1);
});
