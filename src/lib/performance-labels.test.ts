import { test } from "node:test";
import assert from "node:assert/strict";

import { money, moneyShort } from "./format";
import {
  activityLine,
  activitySub,
  BASE_NOT_RECORDED,
  bpPercent,
  collectionLine,
  collectionSub,
  NOTHING_ASSIGNED,
  NOTHING_OVERDUE,
  shareBp,
} from "./performance-labels";

/* ---------------------------------------------------------------------------
 * The two components measured as a share. Pure, so no database.
 *
 * Most of this file is one rule stated several ways, because the rule is about
 * a case that is easy to "simplify" wrongly: a base of zero is NOT a share of
 * zero. The scoring already treats it as "not asked" and drops the component;
 * a screen printing 0% invents a failure nobody recorded.
 * ------------------------------------------------------------------------- */

test("the share is the numerator over its base", () => {
  assert.equal(shareBp({ done: 2_40_000_00, base: 8_10_000_00 }), 2963); // 29.63%
  assert.equal(shareBp({ done: 18, base: 40 }), 4500);
});

test("NO BASE IS NOT ZERO PER CENT — it is no answer at all", () => {
  // The case the whole module exists for. Nothing overdue and no tasks set are
  // statements about the month; scoring drops them, so the screen must not
  // print a figure that reads as a failure.
  assert.equal(shareBp({ done: 0, base: 0 }), null);
  assert.equal(shareBp({ done: 5, base: 0 }), null);
  assert.notEqual(shareBp({ done: 0, base: 0 }), 0);
});

test("a negative base is no base either", () => {
  // `overdueAtStartPaise` is reconstructed from allocations and a credit note
  // landing before the window can in principle take it below zero.
  assert.equal(shareBp({ done: 0, base: -100 }), null);
});

test("collecting everything is 100%, and more than everything is allowed", () => {
  assert.equal(shareBp({ done: 8_10_000_00, base: 8_10_000_00 }), 10_000);
  // Paying off old debt AND this month's is a good month, not a capped one.
  assert.equal(shareBp({ done: 16_20_000_00, base: 8_10_000_00 }), 20_000);
});

test("the collection line names what the money was a share of", () => {
  assert.equal(
    collectionLine({ done: 2_40_000_00, base: 8_10_000_00 }, money),
    "₹2,40,000 of ₹8,10,000 overdue",
  );
  assert.equal(
    collectionLine({ done: 2_40_000_00, base: 8_10_000_00 }, moneyShort),
    "₹2.40L of ₹8.10L overdue",
  );
});

test("and says so in words where there was nothing to collect", () => {
  assert.equal(collectionLine({ done: 0, base: 0 }, money), NOTHING_OVERDUE);
  assert.equal(collectionLine({ done: 0, base: 0 }, moneyShort), NOTHING_OVERDUE);
});

test("the activity line is done OF ASKED, which is the whole point", () => {
  // Ten done means nothing without knowing whether ten or a hundred were set,
  // and a target somebody meets by being given fewer tasks is not a target.
  assert.equal(activityLine({ done: 18, base: 40 }), "18 of 40 tasks");
  assert.equal(activityLine({ done: 10, base: 12 }), "10 of 12 tasks");
  assert.equal(activityLine({ done: 10, base: 100 }), "10 of 100 tasks");
});

test("no tasks set says so rather than reading as none done", () => {
  assert.equal(activityLine({ done: 0, base: 0 }), NOTHING_ASSIGNED);
});

test("bpPercent rounds to whole points, and a dash is not 0%", () => {
  assert.equal(bpPercent(6000), "60%");
  assert.equal(bpPercent(2963), "30%");
  assert.equal(bpPercent(null), "—");
  assert.equal(bpPercent(undefined), "—");
  assert.equal(bpPercent(0), "0%");
});

test("the cell's muted half says the same thing as the tile's sentence", () => {
  const r = { done: 2_40_000_00, base: 8_10_000_00 };
  assert.equal(collectionSub(r, moneyShort), "of ₹8.10L overdue");
  assert.equal(collectionSub(r, money), "of ₹8,10,000 overdue");
  assert.equal(activitySub({ done: 18, base: 40 }), "of 40 set");
});

test("and the empty case is the same sentence in both halves", () => {
  // Not "of ₹0 overdue", which reads as a figure somebody could have beaten.
  assert.equal(collectionSub({ done: 0, base: 0 }, money), NOTHING_OVERDUE);
  assert.equal(activitySub({ done: 0, base: 0 }), NOTHING_ASSIGNED);
});

test("A NULL BASE IS A THIRD ANSWER, and not the empty one", () => {
  /*
   * The office has always had both bases; the handset reads a cached row and
   * only started being sent them when the columns arrived. A row written before
   * that carries null, and reading it as "nothing was overdue" would make a
   * claim about somebody's month on the strength of a column that did not
   * exist when it was written.
   */
  assert.equal(shareBp({ done: 5, base: null }), null);
  assert.equal(collectionLine({ done: 5, base: null }, money), BASE_NOT_RECORDED);
  assert.equal(collectionSub({ done: 5, base: null }, money), BASE_NOT_RECORDED);
  assert.equal(activityLine({ done: 5, base: null }), BASE_NOT_RECORDED);
  assert.equal(activitySub({ done: 5, base: null }), BASE_NOT_RECORDED);
  assert.notEqual(collectionLine({ done: 5, base: null }, money), NOTHING_OVERDUE);
  assert.notEqual(activityLine({ done: 5, base: null }), NOTHING_ASSIGNED);
});
