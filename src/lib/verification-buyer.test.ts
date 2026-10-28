import test from "node:test";
import assert from "node:assert/strict";
import { buyerNeedsCheck } from "@/lib/verification-buyer";

test("no buyer recorded: nothing to check", () => {
  assert.equal(buyerNeedsCheck(null, "Ramesh Patel"), false);
  assert.equal(buyerNeedsCheck("", "Ramesh Patel"), false);
  assert.equal(buyerNeedsCheck("   ", null), false);
});

test("the buyer is the decision maker: not asked twice", () => {
  assert.equal(buyerNeedsCheck("Ramesh Patel", "Ramesh Patel"), false);
  assert.equal(buyerNeedsCheck("ramesh  patel ", "RAMESH PATEL"), false);
});

test("a different person: checked", () => {
  assert.equal(buyerNeedsCheck("Suresh Shah", "Ramesh Patel"), true);
});

test("a buyer with no decision maker on record is checked", () => {
  assert.equal(buyerNeedsCheck("Suresh Shah", null), true);
  assert.equal(buyerNeedsCheck("Suresh Shah", ""), true);
});

test("the comparison is on stored text, so a different spelling is offered rather than skipped", () => {
  assert.equal(buyerNeedsCheck("Patel Ramesh", "Ramesh Patel"), true);
});
