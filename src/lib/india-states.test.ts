import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalState, stateKey, stateVariants } from "./india-states";

/**
 * Every case here is a string that is actually in the production book, with
 * the count it carries, because the point is not that spelling varies — it is
 * how much of a state goes missing when it does.
 */

/** The 24 distinct values `customers.region` holds, with their real counts. */
const BOOK: [string, number][] = [
  ["Maharashtra", 2340], ["Madhya Pradesh", 1282], ["Rajasthan", 985],
  ["Kerala", 609], ["Odisha", 424], ["Gujrat", 97], ["Goa", 42],
  ["Gujarat", 31], ["Karnataka", 22], ["Chhattisgarh", 19], ["Tamilnadu", 14],
  ["Chhattisgadh", 14], ["Uttar Pradesh", 5], ["Telangana", 3],
  ["West Bangal", 3], ["Punjab", 3], ["Bihar", 2], ["Jammu & Kashmir", 2],
  ["TAMIL NADU", 2], ["Andhra Pradesh", 1], ["HARYANA", 1],
  ["Uttarakhand", 1], ["NEW DELHI", 1], ["Daman and Diu", 1],
];

test("the misspelling that holds three quarters of Gujarat folds into it", () => {
  /* 97 rows are spelled "Gujrat" and 31 "Gujarat". Allocating somebody the
     chip that said "Gujarat" gave them 31 customers and silently withheld 97,
     with nothing on any screen saying a second Gujarat existed. */
  assert.equal(canonicalState("Gujrat"), "Gujarat");
  assert.equal(canonicalState("Gujarat"), "Gujarat");
  const keys = stateVariants("Gujarat", BOOK.map(([v]) => v));
  assert.ok(keys.includes("gujrat"), "the filter has to match the misspelling");
  assert.ok(keys.includes("gujarat"));
});

test("case and spacing fold without anybody listing them", () => {
  /* "Tamilnadu" and "TAMIL NADU" are one place two ways. No alias entry
     exists for either — `stateKey` strips to letters, which is what keeps this
     file from needing a line per way of typing a name. */
  assert.equal(stateKey("TAMIL NADU"), "tamilnadu");
  assert.equal(stateKey("Tamilnadu"), "tamilnadu");
  assert.equal(canonicalState("TAMIL NADU"), "Tamil Nadu");
  assert.equal(canonicalState("Tamilnadu"), "Tamil Nadu");
  assert.equal(canonicalState("HARYANA"), "Haryana");
});

test("every real misspelling in the book lands on a canonical name", () => {
  const wrong = ["Gujrat", "Chhattisgadh", "West Bangal", "NEW DELHI"];
  const expected = ["Gujarat", "Chhattisgarh", "West Bengal", "Delhi"];
  assert.deepEqual(wrong.map(canonicalState), expected);
});

test("the whole book collapses to one chip per place", () => {
  const chips = new Set(BOOK.map(([v]) => canonicalState(v)));
  assert.equal(BOOK.length, 24);

  /* THREE PAIRS MERGE, not four. "West Bangal" is corrected to West Bengal and
     merges with nothing, because no correctly-spelled West Bengal is in the
     book — a rename rather than a merge, and the distinction is the whole
     reason to count them separately: merging is what recovers hidden
     customers, renaming only fixes a label. */
  const merged = [...chips].filter(
    (c) => BOOK.filter(([v]) => canonicalState(v) === c).length > 1,
  );
  assert.deepEqual(merged.sort(), ["Chhattisgarh", "Gujarat", "Tamil Nadu"]);
  assert.equal(chips.size, 21);

  /* And no chip is a duplicate of another by any spelling. */
  assert.equal(new Set([...chips].map(stateKey)).size, chips.size);
});

test("merging recovers the customers a chip was silently withholding", () => {
  /* The figure that matters. Before this, the "Gujarat" chip covered 31 of
     128 customers and Chhattisgarh 19 of 33 — and no screen said so. */
  const covered = (canonical: string) =>
    BOOK.filter(([v]) => canonicalState(v) === canonical).reduce((n, [, c]) => n + c, 0);

  assert.equal(covered("Gujarat"), 128);
  assert.equal(covered("Chhattisgarh"), 33);
  assert.equal(covered("Tamil Nadu"), 16);
});

test("a state nobody listed is kept as typed, never guessed into a neighbour", () => {
  /* A place this file has not been taught is far likelier than a typo, and
     folding it on the strength of a string edit would move customers between
     territories. Tidied, not dropped and not corrected. */
  assert.equal(canonicalState("  Some   New State "), "Some New State");
  assert.deepEqual(stateVariants("Some New State"), ["somenewstate"]);
});

test("nothing is not a place", () => {
  assert.equal(canonicalState(""), "");
  assert.equal(canonicalState(null), "");
  assert.equal(canonicalState("   "), "");
  /* An empty key must never reach a filter — `in ('')` would match every row
     whose region is blank, which is a territory nobody allocated. */
  assert.equal(stateVariants("").length, 0);
});

test("a renamed state carries its old name, because the customers are real", () => {
  /* Not misspellings: the country renamed and merged these. The rows are
     correct about where the shop is and wrong only about what it is called
     now. */
  assert.equal(canonicalState("Jammu & Kashmir"), "Jammu and Kashmir");
  assert.equal(canonicalState("Orissa"), "Odisha");
  assert.equal(canonicalState("Pondicherry"), "Puducherry");
  assert.equal(
    canonicalState("Daman and Diu"),
    "Dadra and Nagar Haveli and Daman and Diu",
  );
});

test("variants are keys, not display names, because that is what SQL compares", () => {
  for (const k of stateVariants("Tamil Nadu", ["TAMIL NADU", "Tamilnadu"])) {
    assert.equal(k, stateKey(k), `${k} is not a normalised key`);
  }
});
