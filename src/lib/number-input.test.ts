import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bpFromPercent,
  cleanDecimal,
  cleanWhole,
  parseDecimal,
  parseRupees,
  rupeesFromPaise,
} from "./format";

// The bug this file exists for: "30.5" typed into a rupee box became 305.
test("a decimal box keeps the point and caps the places", () => {
  assert.equal(cleanDecimal("30.5"), "30.5");
  assert.equal(cleanDecimal("1,00,000.505"), "100000.50");
  assert.equal(cleanDecimal("1.2.3"), "1.23");
  assert.equal(cleanDecimal(".5"), ".5");
  assert.equal(cleanDecimal("12.34", 1), "12.3");
  assert.equal(cleanDecimal("₹ 42"), "42");
});

test("a whole box drops the fraction rather than swallowing the point", () => {
  assert.equal(cleanWhole("1.5"), "1.");
  assert.equal(cleanWhole("12"), "12");
  assert.equal(cleanWhole("1,200"), "1200");
  // Typed a keystroke at a time, as a box sees it: never 15.
  let box = "";
  for (const key of ["1", ".", "5"]) box = cleanWhole(box + key);
  assert.equal(box, "1.");
  assert.equal(Number(box), 1);
});

test("parseDecimal reads what a person types, and nothing else", () => {
  assert.equal(parseDecimal("30.5"), 30.5);
  assert.equal(parseDecimal("1,00,000.25"), 100000.25);
  assert.equal(parseDecimal(".5"), 0.5);
  assert.equal(parseDecimal("7."), 7);
  assert.equal(parseDecimal(""), null);
  assert.equal(parseDecimal("."), null);
  assert.equal(parseDecimal("1.2.3"), null);
  assert.equal(parseDecimal("abc"), null);
});

test("rupees round-trip through paise without losing the paise", () => {
  assert.equal(parseRupees("30.5"), 3050);
  assert.equal(parseRupees("10.17"), 1017);
  assert.equal(rupeesFromPaise(1017), "10.17");
  assert.equal(rupeesFromPaise(3050), "30.50");
  assert.equal(rupeesFromPaise(116800), "1168");
  assert.equal(rupeesFromPaise(5), "0.05");
  assert.equal(parseRupees(rupeesFromPaise(1045060)), 1045060);
});

test("a percent becomes basis points", () => {
  assert.equal(bpFromPercent("1.5"), 150);
  assert.equal(bpFromPercent("18"), 1800);
  assert.equal(bpFromPercent("2.25"), 225);
  assert.equal(bpFromPercent(""), null);
});
