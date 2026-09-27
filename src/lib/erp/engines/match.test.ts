import { test } from "node:test";
import assert from "node:assert/strict";
import { bestMatches, sameGstin, similarity, toCans } from "./match";

test("shop shorthand folds to the catalogue's words, and sizes count double", () => {
  assert.ok(similarity("NC 1L", "Mahek N C Thinner - 1 Liter (Loose)") > 0.3);
  assert.ok(similarity("nc thinner 1 ltr", "Mahek NC Thinner - 1 Liter (Loose)") > similarity("nc thinner 1 ltr", "Mahek NC Thinner - 5 Liter (Loose)"));
});

test("a close call is a choice, never a silent pick", () => {
  const skus = ["Mahek NC Thinner - 1 Liter (Loose)", "Mahek NC Thinner - 1 Liter (24 Can/Box)", "Stoving Thinner - 20 Liter"];
  const close = bestMatches("NC thinner 1 liter", skus, (s) => s);
  assert.equal(close.sure, null);
  assert.ok(close.choices.length >= 2);
  const clear = bestMatches("stoving 20 ltr", skus, (s) => s);
  assert.equal(clear.sure, "Stoving Thinner - 20 Liter");
  const boosted = bestMatches("NC thinner 1 liter", skus, (s) => s, { boost: (s) => (s.includes("24 Can") ? 0.3 : 0) });
  assert.equal(boosted.sure, "Mahek NC Thinner - 1 Liter (24 Can/Box)", "what the party bought before breaks the tie");
});

test("quantities convert to cans, and refuse a part-can", () => {
  assert.deepEqual(toCans(20, "peti", 24, 1).cans, 480);
  assert.deepEqual(toCans(5, "drum", 1, 210).cans, 5);
  assert.equal(toCans(10, "ltr", 1, 5).cans, 2);
  assert.equal(toCans(7, "ltr", 1, 5).cans, null);
  assert.ok(sameGstin("27abcde1234f1z5", "27 ABCDE 1234 F1Z5"));
});
