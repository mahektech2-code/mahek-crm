import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { istDateKey } from "../date";
import { addDays, dayDiff, daysInMonth, isLeapYear, isValidDateKey, monthGrid } from "./date-key";
import { nextOccurrence, parseRecurringDate } from "./recurring-date";

describe("date keys", () => {
  test("real calendar dates only", () => {
    assert.equal(isValidDateKey("2028-02-29"), true);
    for (const bad of ["2027-02-29", "2026-13-01", "2026-04-31", "2026-00-10", "2026-1-1", "", null, 20260101]) assert.equal(isValidDateKey(bad), false, String(bad));
  });
  test("leap years", () => {
    assert.deepEqual([2024, 2028, 2000].map(isLeapYear), [true, true, true]);
    assert.deepEqual([2026, 2027, 1900, 2100].map(isLeapYear), [false, false, false, false]);
    assert.equal(daysInMonth(2028, 2), 29);
    assert.equal(daysInMonth(2027, 2), 28);
  });
  test("arithmetic crosses months and years", () => {
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2028-02-28", 1), "2028-02-29");
    assert.equal(dayDiff("2026-12-25", "2027-01-05"), 11);
    assert.equal(dayDiff("2027-01-05", "2026-12-25"), -11);
  });
  test("month grid starts on Sunday and pads to whole weeks", () => {
    const weeks = monthGrid(2026, 11); // 1 Nov 2026 is a Sunday
    assert.equal(weeks[0]?.[0], "2026-11-01");
    assert.ok(weeks.every((w) => w.length === 7));
    assert.equal(weeks.flat().filter(Boolean).length, 30);
    assert.equal(monthGrid(2026, 10)[0]?.[0], null); // 1 Oct 2026 is a Thursday
  });
});

describe("parseRecurringDate", () => {
  test("full date and year-less date", () => {
    assert.deepEqual(parseRecurringDate("1990-03-14"), { month: 3, day: 14, year: 1990 });
    assert.deepEqual(parseRecurringDate("--03-14"), { month: 3, day: 14, year: null });
    assert.deepEqual(parseRecurringDate("--02-29"), { month: 2, day: 29, year: null });
  });
  test("a date that does not exist, or a wrong spelling, is refused and never repaired", () => {
    for (const bad of ["1999-02-29", "1990-04-31", "--02-30", "--13-01", "14/03/1990", "", "  ", null, undefined, 5]) assert.equal(parseRecurringDate(bad), null, String(bad));
  });
});

describe("nextOccurrence", () => {
  test("today counts as 0 days", () => {
    const o = nextOccurrence("1990-10-22", "2026-10-22");
    assert.equal(o?.date, "2026-10-22");
    assert.equal(o?.daysUntil, 0);
    assert.equal(o?.years, 36);
  });
  test("a date already gone this year comes round next year", () => {
    const o = nextOccurrence("1990-10-21", "2026-10-22");
    assert.equal(o?.date, "2027-10-21");
    assert.equal(o?.daysUntil, 364);
    assert.equal(o?.years, 37);
  });
  test("year end: 31 December to 1 January", () => {
    assert.equal(nextOccurrence("--01-01", "2026-12-31")?.daysUntil, 1);
    assert.equal(nextOccurrence("--01-01", "2026-12-31")?.date, "2027-01-01");
  });
  test("leap day is marked on 28 February in a year without one, and says so", () => {
    const a = nextOccurrence("2000-02-29", "2026-10-22");
    assert.equal(a?.date, "2027-02-28");
    assert.equal(a?.observedOnFallback, true);
    const b = nextOccurrence("2000-02-29", "2027-10-22");
    assert.equal(b?.date, "2028-02-29");
    assert.equal(b?.observedOnFallback, false);
    assert.equal(b?.years, 28);
  });
  test("leap day seen from late February of a non-leap year", () => {
    assert.equal(nextOccurrence("--02-29", "2027-02-28")?.daysUntil, 0);
    assert.equal(nextOccurrence("--02-29", "2027-03-01")?.date, "2028-02-29");
  });
  test("a year-less date has no age", () => {
    assert.equal(nextOccurrence("--05-05", "2026-10-22")?.years, null);
  });
  test("a birth year in the future gives no age", () => {
    assert.equal(nextOccurrence("2030-10-22", "2026-10-22")?.years, null);
  });
  test("bad input gives null", () => {
    assert.equal(nextOccurrence("2027-02-29", "2026-10-22"), null);
    assert.equal(nextOccurrence("1990-01-01", "not-a-date"), null);
    assert.equal(nextOccurrence(null, "2026-10-22"), null);
  });
});

describe("India time zone boundary (today is the India date, not the UTC date)", () => {
  test("18:31 UTC on 31 December is already 1 January in India", () => {
    const today = istDateKey(new Date("2026-12-31T18:31:00Z"));
    assert.equal(today, "2027-01-01");
    assert.equal(nextOccurrence("--01-01", today)?.daysUntil, 0);
  });
  test("18:29 UTC on 31 December is still 31 December in India", () => {
    const today = istDateKey(new Date("2026-12-31T18:29:00Z"));
    assert.equal(today, "2026-12-31");
    assert.equal(nextOccurrence("--01-01", today)?.daysUntil, 1);
  });
});
