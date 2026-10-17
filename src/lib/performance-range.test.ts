import test from "node:test";
import assert from "node:assert/strict";
import { checkRange, presetOf, presetRange, rangeLabel, wholeMonthOf } from "./performance-range";

test("a range is checked and never clamped to today", () => {
  const out = checkRange("2026-10-01", "2026-10-31", "2026-10-07");
  assert.deepEqual(out, { ok: true, range: { from: "2026-10-01", to: "2026-10-31" } });
});

test("a range that has not started, or runs backwards, is refused", () => {
  assert.equal(checkRange("2026-11-01", "2026-11-30", "2026-10-07").ok, false);
  assert.equal(checkRange("2026-10-10", "2026-10-01", "2026-10-07").ok, false);
  assert.equal(checkRange("bad", "2026-10-01", "2026-10-07").ok, false);
  assert.equal(checkRange("2015-01-01", "2026-10-01", "2026-10-07").ok, false);
});

test("presets are whole months, financial quarters and financial years", () => {
  const today = "2026-10-07";
  assert.deepEqual(presetRange("this-month", today), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(presetRange("last-month", today), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(presetRange("this-quarter", today), { from: "2026-10-01", to: "2026-12-31" });
  assert.deepEqual(presetRange("last-quarter", today), { from: "2026-07-01", to: "2026-09-30" });
  assert.deepEqual(presetRange("this-year", today), { from: "2026-04-01", to: "2027-03-31" });
  assert.deepEqual(presetRange("last-year", "2027-02-10"), { from: "2025-04-01", to: "2026-03-31" });
  assert.deepEqual(presetRange("last-month", "2026-01-15"), { from: "2025-12-01", to: "2025-12-31" });
});

test("a range names itself", () => {
  assert.equal(presetOf({ from: "2026-10-01", to: "2026-10-31" }, "2026-10-07"), "this-month");
  assert.equal(presetOf({ from: "2026-10-02", to: "2026-10-31" }, "2026-10-07"), null);
  assert.equal(wholeMonthOf({ from: "2026-02-01", to: "2026-02-28" }), "2026-02");
  assert.equal(rangeLabel({ from: "2026-10-01", to: "2026-10-31" }), "Oct 2026");
  assert.equal(rangeLabel({ from: "2026-04-01", to: "2027-03-31" }), "1 Apr 2026 – 31 Mar 2027");
});
