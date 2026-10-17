import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentYear,
  pickYear,
  yearDates,
  yearKindOf,
  yearLabel,
  yearOptions,
  yearRange,
  yearSpanLabel,
} from "./year-period";

test("a year string says which way it counts", () => {
  assert.equal(yearKindOf("26-27"), "fy");
  assert.equal(yearKindOf("2026"), "cy");
  assert.equal(yearKindOf("99-00"), "fy");
  // Not years: a pair that does not follow on, and anything else.
  assert.equal(yearKindOf("26-28"), null);
  assert.equal(yearKindOf("all"), null);
  assert.equal(yearKindOf(""), null);
  assert.equal(yearKindOf(undefined), null);
});

test("ranges are half-open, and the inclusive form ends the day before", () => {
  assert.deepEqual(yearRange("26-27"), { start: "2026-04-01", end: "2027-04-01" });
  assert.deepEqual(yearRange("2026"), { start: "2026-01-01", end: "2027-01-01" });
  assert.deepEqual(yearDates("26-27"), { from: "2026-04-01", to: "2027-03-31" });
  assert.deepEqual(yearDates("2024"), { from: "2024-01-01", to: "2024-12-31" });
});

test("labels name the year and the dates it covers", () => {
  assert.equal(yearLabel("26-27"), "FY 2026-27");
  assert.equal(yearLabel("99-00"), "FY 2099-00");
  assert.equal(yearLabel("2026"), "2026");
  assert.equal(yearSpanLabel("26-27"), "1 Apr 2026 – 31 Mar 2027");
  assert.equal(yearSpanLabel("2026"), "1 Jan 2026 – 31 Dec 2026");
});

test("the current year depends on the way of counting", () => {
  assert.equal(currentYear("2026-03-31", "fy"), "25-26");
  assert.equal(currentYear("2026-04-01", "fy"), "26-27");
  assert.equal(currentYear("2026-03-31", "cy"), "2026");
});

test("options run from the oldest record to today, newest first, both ways", () => {
  const o = yearOptions("2024-02-10", "2026-10-10");
  assert.deepEqual(o.fy, ["26-27", "25-26", "24-25", "23-24"]);
  assert.deepEqual(o.cy, ["2026", "2025", "2024"]);
  // No records yet: today's year of each kind is still offered.
  assert.deepEqual(yearOptions(null, "2026-10-10"), { fy: ["26-27"], cy: ["2026"] });
});

test("the default is the current financial year, and only offered years are honoured", () => {
  const o = yearOptions("2025-05-01", "2026-10-10");
  assert.equal(pickYear(undefined, o, "2026-10-10"), "26-27");
  assert.equal(pickYear("2025", o, "2026-10-10"), "2025");
  assert.equal(pickYear("25-26", o, "2026-10-10"), "25-26");
  assert.equal(pickYear("2019", o, "2026-10-10"), "26-27");
  assert.equal(pickYear("nonsense", o, "2026-10-10"), "26-27");
});
