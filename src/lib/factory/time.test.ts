import { test } from "node:test";
import assert from "node:assert/strict";
import { clock12, clockText } from "./time";

test("clock12 reads a 24-hour HH:MM the 12-hour way", () => {
  assert.equal(clock12("15:00"), "3 PM");
  assert.equal(clock12("10:00"), "10 AM");
  assert.equal(clock12("09:05"), "9:05 AM");
  assert.equal(clock12("00:30"), "12:30 AM");
  assert.equal(clock12("12:00"), "12 PM");
  assert.equal(clock12("23:59"), "11:59 PM");
  assert.equal(clock12(""), "");
  assert.equal(clock12("—"), "—");
});

test("clockText rewrites only the times inside a sentence", () => {
  assert.equal(clockText("Today 14:30 · Ravi"), "Today 2:30 PM · Ravi");
  assert.equal(clockText("2026-10-13 09:00 · held"), "2026-10-13 9 AM · held");
  assert.equal(clockText("Lot FG12NA · 40 L"), "Lot FG12NA · 40 L");
  assert.equal(clockText("12:30:45"), "12:30:45");
});
