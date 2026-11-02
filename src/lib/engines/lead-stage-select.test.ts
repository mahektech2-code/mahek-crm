import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { LeadGateInput } from "./lead-gates";
import { SAMPLE_CONDITION_IDS, skippedSentence, stageSelection } from "./lead-stage-select";

/* A Sales Manager choosing a later stage from Qualification: what is open, what
   is not, and what is never lifted. Pure — no database. */

const NEXT_ACTION = {
  nextAction: "Ring the owner",
  nextActionDate: "2026-09-14",
  nextActionOwnerId: "u1",
} as const;

const ANSWERS: Record<string, string> = {
  trial_product: "PU Thinner",
  trial_pack: "20 L",
  trial_quantity: "2 cans",
  trial_tester: "Ramesh",
  trial_duration: "7 days",
  buyer_same: "yes",
  payer_same: "yes",
  price_range: "180 to 200 a litre",
  price_reaction: "accepted",
  delivery_location: "Nashik",
  delivery_lead_time: "3 days",
  delivery_suits: "yes",
  willing_to_test: "yes",
  next_step: "First order of 200 L",
  next_step_date: "2026-11-01",

};

function ready(over: Partial<LeadGateInput> = {}): LeadGateInput {
  return {
    salesType: "direct",
    stage: "qualification",
    gstin: "27AAAPL1234C1ZV",
    gstVerified: true,
    monthlyLitres: 400,
    potentialPaise: 15_00_000,
    requiredProductId: "p1",
    competitor: "Asian Paints",
    creditDaysWanted: 30,
    decisionMaker: "Ramesh",
    application: "Wood finishing",
    qualification: { ...ANSWERS },
    qualificationReview: "verified",
    ...NEXT_ACTION,
    ...over,
  };
}
const opts = { requireNextAction: true };
const choice = (sel: ReturnType<typeof stageSelection>, to: string) => sel.choices.find((c) => c.to === to)!;

describe("stage selection from Qualification", () => {
  test("is offered at Qualification on the direct and third-party ladders only", () => {
    assert.equal(stageSelection(ready(), opts).applies, true);
    assert.equal(stageSelection(ready({ salesType: "third_party", distributorCount: 1 }), opts).applies, true);
    assert.equal(stageSelection(ready({ stage: "prospect" }), opts).applies, false);
    assert.equal(stageSelection(ready({ stage: "sample_trial" }), opts).applies, false);
    assert.equal(stageSelection(ready({ salesType: "distributor" }), opts).applies, false);
    assert.equal(stageSelection(ready({ salesType: null }), opts).applies, false);
  });

  test("a verified, complete Qualification opens Sample / Trial and Negotiation, and Negotiation skips the sample rungs", () => {
    const sel = stageSelection(ready(), opts);
    assert.deepEqual(sel.entryMissing, []);
    assert.equal(choice(sel, "sample_trial").available, true);
    assert.deepEqual(choice(sel, "sample_trial").skips, []);
    const neg = choice(sel, "negotiation");
    assert.equal(neg.available, true, "no sample is needed to choose Negotiation");
    assert.deepEqual(neg.skips, ["sample_trial", "sample_review"]);
    assert.ok(!sel.choices.some((c) => c.to === "sample_review"), "the second half of the trial is not a place to arrive");
  });

  test("the review must be VERIFIED — pending, incomplete, clarification and a voided one each shut every choice", () => {
    for (const review of [null, undefined, "incomplete", "clarification"] as const) {
      const sel = stageSelection(ready({ qualificationReview: review }), opts);
      assert.ok(sel.entryMissing.length > 0, `review ${String(review)} leaves the entry gate shut`);
      assert.ok(sel.choices.every((c) => !c.available), `nothing is available while the review is ${String(review)}`);
    }
  });

  test("an unanswered question, an unvalidated GST and a missing distributor each block it", () => {
    const answers = { ...ready().qualification } as Record<string, string>;
    delete answers.trial_product;
    assert.ok(stageSelection(ready({ qualification: answers }), opts).entryMissing.length > 0);
    assert.ok(stageSelection(ready({ gstVerified: false }), opts).entryMissing.length > 0);
    const third = stageSelection(ready({ salesType: "third_party", distributorCount: 0 }), opts);
    assert.ok(third.entryMissing.some((c) => c.id === "distributor_named"));
    assert.ok(third.choices.every((c) => !c.available));
  });

  test("later stages stay gated by their REAL facts and say why", () => {
    const sel = stageSelection(ready(), opts);
    for (const to of ["first_order", "delivery", "payment", "second_order", "customer"]) {
      const c = choice(sel, to);
      assert.equal(c.available, false, `${to} needs a real record`);
      assert.ok(c.reasons.length > 0, `${to} says why`);
    }
    const withOrder = stageSelection(
      ready({ countingOrderCount: 1, expectedOrderDate: "2026-11-05" }),
      opts,
    );
    assert.equal(choice(withOrder, "first_order").available, true, "an order that exists opens 1st order");
    assert.equal(choice(withOrder, "payment").available, false, "money not confirmed keeps Payment shut");
  });

  test("only the three sample conditions are lifted, and only by id", () => {
    assert.deepEqual([...SAMPLE_CONDITION_IDS].sort(), ["sample_approved", "sample_reviewed", "sample_sent"]);
    const sel = stageSelection(ready({ qualificationReview: null }), opts);
    assert.ok(choice(sel, "negotiation").missing.some((c) => c.id === "manager_review_pending"), "the review is never lifted");
  });

  test("the Verification Call is read nowhere: a lead with no verification stays selectable", () => {
    const sel = stageSelection(ready({ verifiedAt: null }), opts);
    assert.equal(choice(sel, "negotiation").available, true);
  });

  test("§24's next action follows the setting, like every other move", () => {
    const noNext = ready({ nextAction: null, nextActionDate: null, nextActionOwnerId: null });
    assert.equal(choice(stageSelection(noNext, { requireNextAction: true }), "negotiation").available, false);
    assert.equal(choice(stageSelection(noNext, { requireNextAction: false }), "negotiation").available, true);
  });

  test("the skipped rungs read in words", () => {
    assert.equal(skippedSentence(["sample_trial", "sample_review"]), "Sample / trial and Sample received & review");
  });
});
