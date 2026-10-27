import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bpFromPercent,
  cleanDecimal,
  cleanWhole,
  money,
  moneyShort,
  parseDecimal,
  parseRupees,
  rupeesFromPaise,
  signedMoney,
} from "./format";
import { inr as erpInr, rupeesField } from "./erp/ui";
import { crore as ccCrore, inr as ccInr } from "./command-centre/format";

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

// The second half of the bug: a box kept "1234.56" to the paisa, and every
// screen then showed it as ₹1,235. Paise show wherever the record has them.
test("an amount shows its paise, and a whole amount reads as it always did", () => {
  assert.equal(money(123456), "₹1,234.56");
  assert.equal(money(123405), "₹1,234.05");
  assert.equal(money(123400), "₹1,234");
  assert.equal(money(18_42_000_50), "₹18,42,000.50");
  assert.equal(money(null), "₹0");
  assert.equal(signedMoney(-123456), "−₹1,234.56");
  assert.equal(signedMoney(5000), "₹50");
  assert.equal(moneyShort(1250), "₹12.50");
  assert.equal(moneyShort(-1250), "₹-12.50");
  assert.equal(moneyShort(51_20_000_00), "₹51.20L");
});

test("the ERP and the Command Centre show the same paise", () => {
  assert.equal(erpInr(1045060), "₹10,450.60");
  assert.equal(erpInr(1045000), "₹10,450");
  assert.equal(erpInr(-1045060), "−₹10,450.60");
  assert.equal(rupeesField(1017), "10.17");
  assert.equal(rupeesField(1050), "10.50");
  assert.equal(ccInr(240_550_50), "₹2,40,550.50");
  assert.equal(ccInr(-12_345), "−₹123.45");
  assert.equal(ccCrore(84_600_25), "₹84,600.25");
  assert.equal(ccCrore(3_48_00_000_00), "₹3.48 Cr");
});
