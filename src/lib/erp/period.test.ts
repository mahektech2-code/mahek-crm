/**
 * The window a register is read through (`period.ts`). Pure: the picker in the
 * browser and the page on the server read a period with these functions, so
 * the label on the button and the rows under it describe the same dates.
 *
 *   npm run test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { customKey, customRange, periodLabel, periodWindow, shiftDays, validPeriod } from "./period";

test("rolling presets end today and count today as one of their days", () => {
  assert.deepEqual(periodWindow("7d", "2026-10-17"), { from: "2026-10-11", to: "2026-10-17" });
  assert.deepEqual(periodWindow("30d", "2026-10-17"), { from: "2026-09-18", to: "2026-10-17" });
  assert.deepEqual(periodWindow("90d", "2026-03-01"), { from: "2025-12-02", to: "2026-03-01" });
});

test("this month and last month are whole calendar months, across a year end", () => {
  assert.deepEqual(periodWindow("month", "2026-02-10"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(periodWindow("month", "2028-02-10"), { from: "2028-02-01", to: "2028-02-29" });
  assert.deepEqual(periodWindow("lastMonth", "2026-01-05"), { from: "2025-12-01", to: "2025-12-31" });
});

test("the financial year runs April to March, as Mahek's bill numbers do", () => {
  assert.deepEqual(periodWindow("fy", "2026-10-17"), { from: "2026-04-01", to: "2027-03-31" });
  assert.deepEqual(periodWindow("fy", "2026-03-31"), { from: "2025-04-01", to: "2026-03-31" });
  assert.deepEqual(periodWindow("fy", "2026-04-01"), { from: "2026-04-01", to: "2027-03-31" });
  assert.deepEqual(periodWindow("lastFy", "2026-10-17"), { from: "2025-04-01", to: "2026-03-31" });
});

test("all time is open at both ends", () => {
  assert.deepEqual(periodWindow("all", "2026-10-17"), { from: null, to: null });
});

test("a custom range survives the URL, either end may be open, and a reversed one is put the right way round", () => {
  assert.deepEqual(customRange(customKey({ from: "2026-01-01", to: "2026-03-31" })), { from: "2026-01-01", to: "2026-03-31" });
  assert.deepEqual(customRange("c:2026-05-01:"), { from: "2026-05-01", to: null });
  assert.deepEqual(customRange("c:2026-03-31:2026-01-01"), { from: "2026-01-01", to: "2026-03-31" });
  assert.equal(customRange("c::"), null, "a range with neither end is not a range");
  assert.equal(customRange("c:yesterday:today"), null);
  assert.deepEqual(periodWindow("c:2026-01-01:2026-01-31", "2026-10-17"), { from: "2026-01-01", to: "2026-01-31" });
});

test("only a preset, a real range or the default is accepted from the URL", () => {
  assert.ok(validPeriod(""));
  assert.ok(validPeriod("month"));
  assert.ok(validPeriod("c:2026-01-01:2026-01-31"));
  assert.ok(!validPeriod("forever"));
  assert.ok(!validPeriod("c:junk:"));
});

test("the button says the period in words", () => {
  assert.equal(periodLabel("month"), "This month");
  assert.equal(periodLabel("c:2026-01-01:2026-03-31"), "1 Jan 2026 – 31 Mar 2026");
  assert.equal(periodLabel("c:2026-01-01:2026-01-01"), "1 Jan 2026");
  assert.equal(periodLabel("c:2026-05-01:"), "From 1 May 2026");
});

test("days move on the calendar, with no clock and so no zone", () => {
  assert.equal(shiftDays("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDays("2026-12-31", 1), "2027-01-01");
});
