import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { coverageStatus, countdownLabel, festivalCalendarSchema, horizonOf, isVerified, parseCategory, parseDateParam, parseView, selectEntries, type CalendarEntry } from "./festival-calendar";

const entry = (id: string, date: string, extra: Partial<CalendarEntry> = {}): CalendarEntry => ({ id, label: id, date, category: "hindu", occasionId: null, source: "s", list: "gazetted", ...extra });

const SRC = { title: "t", reference: "r", transcribedFrom: "u", retrievedOn: "2026-10-22", verification: "official-list-secondary-copy", caveat: "c" } as const;
const calendar = (entries: CalendarEntry[], coverage = { from: "2026-01-01", to: "2027-12-31" }) => ({ sources: { s: SRC }, coverage, entries });

describe("calendar file rules", () => {
  test("a valid calendar parses", () => {
    assert.ok(festivalCalendarSchema.safeParse(calendar([entry("diwali-2026", "2026-11-08")])).success);
  });
  test("refuses a date that does not exist, a duplicate id, an unknown source, an id that disagrees with the year, a date outside the coverage", () => {
    const bad = [
      calendar([entry("x-2027", "2027-02-29")]),
      calendar([entry("x-2026", "2026-01-01"), entry("x-2026", "2026-01-02")]),
      calendar([entry("x-2026", "2026-01-01", { source: "nope" })]),
      calendar([entry("x-2026", "2027-01-01")]),
      calendar([entry("x-2028", "2028-01-01")]),
    ];
    for (const c of bad) assert.equal(festivalCalendarSchema.safeParse(c).success, false);
  });
  test("an entry with no source is allowed but reads as unverified", () => {
    const e = entry("x-2026", "2026-05-05", { source: null });
    assert.ok(festivalCalendarSchema.safeParse(calendar([e])).success);
    assert.equal(isVerified(e), false);
    assert.equal(isVerified(entry("y-2026", "2026-05-05")), true);
  });
  test("an unknown field is refused (no silent extras)", () => {
    assert.equal(festivalCalendarSchema.safeParse({ ...calendar([]), extra: 1 }).success, false);
  });
});

describe("horizon and countdown", () => {
  test("today, 7 days, 30 days, later, past", () => {
    assert.deepEqual([0, 1, 7, 8, 30, 31, -1].map(horizonOf), ["today", "week", "week", "month", "month", "later", "past"]);
  });
  test("labels", () => {
    assert.deepEqual([0, 1, 5, -1, -3].map(countdownLabel), ["Today", "Tomorrow", "in 5 days", "Yesterday", "3 days ago"]);
  });
});

describe("selectEntries", () => {
  const list = [
    entry("past-2026", "2026-10-20"),
    entry("today-2026", "2026-10-22", { category: "national" }),
    entry("d7-2026", "2026-10-29", { category: "hindu", occasionId: "diwali" }),
    entry("d8-2026", "2026-10-30", { category: "muslim" }),
    entry("d30-2026", "2026-11-21", { category: "sikh" }),
    entry("d31-2026", "2026-11-22", { category: "christian" }),
  ];
  const ids = (v: ReturnType<typeof selectEntries>) => v.map((e) => e.id);
  test("past entries are never returned", () => assert.ok(!ids(selectEntries(list, "2026-10-22")).includes("past-2026")));
  test("today / 7 / 30 / all windows (edges inclusive)", () => {
    assert.deepEqual(ids(selectEntries(list, "2026-10-22", { view: "today" })), ["today-2026"]);
    assert.deepEqual(ids(selectEntries(list, "2026-10-22", { view: "7" })), ["today-2026", "d7-2026"]);
    assert.deepEqual(ids(selectEntries(list, "2026-10-22", { view: "30" })), ["today-2026", "d7-2026", "d8-2026", "d30-2026"]);
    assert.equal(selectEntries(list, "2026-10-22", { view: "all" }).length, 5);
  });
  test("category and date-range filters combine", () => {
    assert.deepEqual(ids(selectEntries(list, "2026-10-22", { category: "muslim" })), ["d8-2026"]);
    assert.deepEqual(ids(selectEntries(list, "2026-10-22", { from: "2026-10-29", to: "2026-10-30" })), ["d7-2026", "d8-2026"]);
    assert.deepEqual(ids(selectEntries(list, "2026-10-22", { category: "hindu", from: "2026-10-30" })), []);
  });
  test("design filter uses the supplied lookup (with / without an approved design)", () => {
    const has = (e: CalendarEntry) => e.occasionId === "diwali";
    assert.deepEqual(ids(selectEntries(list, "2026-10-22", { hasDesign: true }, has)), ["d7-2026"]);
    assert.equal(selectEntries(list, "2026-10-22", { hasDesign: false }, has).length, 4);
  });
  test("results are soonest first", () => {
    const dates = selectEntries([...list].reverse(), "2026-10-22").map((e) => e.date);
    assert.deepEqual(dates, [...dates].sort());
  });
  test("an empty calendar gives an empty list, not an error", () => assert.deepEqual(selectEntries([], "2026-10-22"), []));
});

describe("URL parameters never throw", () => {
  test("unknown values are ignored", () => {
    assert.equal(parseCategory("nonsense"), undefined);
    assert.equal(parseCategory("sikh"), "sikh");
    assert.equal(parseView("zzz"), "30");
    assert.equal(parseView("7"), "7");
    assert.equal(parseDateParam("2026-02-30"), undefined);
    assert.equal(parseDateParam("2026-02-27"), "2026-02-27");
    assert.equal(parseDateParam(undefined), undefined);
  });
});

describe("coverage (a year that is not loaded reads as not loaded, never as no festivals)", () => {
  const cov = { from: "2026-01-01", to: "2027-12-31" };
  test("inside", () => assert.deepEqual(coverageStatus(cov, "2026-10-22"), { covered: true }));
  test("after the end", () => {
    const s = coverageStatus(cov, "2028-01-02");
    assert.equal(s.covered === false && s.reason, "after");
  });
  test("close to the end", () => {
    const s = coverageStatus(cov, "2027-12-20");
    assert.equal(s.covered === false && s.reason, "ends-soon");
  });
  test("before the start", () => assert.equal(coverageStatus(cov, "2025-12-01").covered, false));
});
