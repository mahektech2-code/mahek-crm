import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { combinedReviewApplies } from "@/lib/combined-review";
import { combinedConfirmBlockers } from "@/lib/qualification-review";
import type { LeadGateInput } from "@/lib/engines/lead-gates";

describe("who the one-review flow applies to", () => {
  test("a direct or third-party Prospect", () => {
    assert.equal(combinedReviewApplies({ stage: "prospect", salesType: "direct" }), true);
    assert.equal(combinedReviewApplies({ stage: "prospect", salesType: "third_party" }), true);
  });
  test("a Suspect only when the calling desk has asked for it to be a Prospect", () => {
    assert.equal(combinedReviewApplies({ stage: "suspect", salesType: "direct" }), false);
    assert.equal(combinedReviewApplies({ stage: "suspect", salesType: "direct", deskRequest: true }), true);
    assert.equal(combinedReviewApplies({ stage: "new", salesType: "direct", deskRequest: true }), true);
  });
  test("never a distributor, a lead with no sales type, or a lead already past Prospect", () => {
    assert.equal(combinedReviewApplies({ stage: "prospect", salesType: "distributor" }), false);
    assert.equal(combinedReviewApplies({ stage: "prospect", salesType: null }), false);
    assert.equal(combinedReviewApplies({ stage: "qualification", salesType: "direct" }), false);
    assert.equal(combinedReviewApplies({ stage: "sample_trial", salesType: "direct" }), false);
    assert.equal(combinedReviewApplies({ stage: null, salesType: "direct", deskRequest: true }), false);
  });
});

describe("what holds the ONE Confirm", () => {
  const gate: LeadGateInput = { salesType: "direct", stage: "prospect" };
  test("names the Qualification questions, never the three things confirming itself settles", () => {
    const ids = combinedConfirmBlockers(gate).map((c) => c.id);
    assert.ok(ids.includes("trial_plan"), "an unanswered Qualification question holds it");
    assert.ok(ids.includes("gst_verified"), "so does an unchecked GST number (the reviewer ticks it)");
    for (const settled of ["manager_review_pending", "manager_review_open", "next_action", "figures_fresh"]) {
      assert.equal(ids.includes(settled), false, `${settled} is settled by confirming`);
    }
  });
});
