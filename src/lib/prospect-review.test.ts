import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prospectReviewStateOf, PROSPECT_REVIEW_AUDIT } from "./prospect-review";

const read = (p: string) => readFileSync(p, "utf8");
const base = { stage: "prospect", verifiedAt: null, nextAction: null, requestState: null } as never;

describe("prospect review state", () => {
  test("a prospect not yet verified is pending", () => {
    assert.equal(prospectReviewStateOf({ ...(base as object), stage: "prospect" } as never), "pending");
  });
  test("a verified prospect is confirmed", () => {
    assert.equal(prospectReviewStateOf({ ...(base as object), verifiedAt: new Date() } as never), "confirmed");
  });
  test("every decision has its own audit action", () => {
    assert.equal(new Set(Object.values(PROSPECT_REVIEW_AUDIT)).size, 4);
  });
});

describe("the decision doors", () => {
  const act = read("src/lib/actions/prospect-review.ts");
  test("confirm and return go through the designated verifier gate", () => {
    assert.ok((act.match(/requireProspectVerifier\(customerId\)/g) ?? []).length >= 2);
  });
  test("returning demands a reason", () => {
    assert.match(act, /reason|note/);
  });
  test("confirming opens Qualification through the shared function, with no call needed", () => {
    assert.match(act, /openQualificationAfterVerification/);
    assert.match(act, /evidence: "review"/);
  });
});

describe("the call is optional", () => {
  test("the dialog says so and the queue leads with the review", () => {
    assert.match(read("src/components/leads/verification-form.tsx"), /Verification call \(optional\)/);
    const q = read("src/components/leads/qualify/verification/verification-queue-screen.tsx");
    assert.match(q, /Review answers/);
    assert.match(q, /Call \(optional\)/);
  });
  test("the Qualify page shows the review first to the verifier", () => {
    assert.match(read("src/components/leads/pages/leads-record-qualify.tsx"), /reviewModel\?\.viewer\.canDecide/);
  });
  test("Sample/Trial gate is untouched by this change", () => {
    assert.doesNotMatch(read("src/lib/actions/prospect-review.ts"), /sample_trial|requestSample/);
  });
});
