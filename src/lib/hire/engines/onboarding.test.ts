import { test } from "node:test";
import assert from "node:assert/strict";
import { basicDelta, courierOverall, fillTemplate, needsApproval, nextEmpDocStep, onboardingStatus, unknownPlaceholders, type OnboardingFacts } from "./onboarding";
import { canMove } from "./gating";
import { blocking, validateBlueprint } from "./validator";
import { SALES_EXECUTIVE } from "../seed/blueprints";
import { ACCOUNTS_EXECUTIVE_V3, SALES_EXECUTIVE_V4, TELECALLER_V2 } from "../seed/onboarding";
import { isOnboardingFlow, isPostHireStage } from "../blueprint-types";

const L = 100;

test("approval: only a negotiated basic MORE than the line above the first proposal", () => {
  assert.equal(needsApproval(19_500 * L, 20_475 * L, 5), false, "exactly +5% is at the line, not over it");
  assert.equal(needsApproval(19_500 * L, 21_000 * L, 5), true);
  assert.equal(needsApproval(19_500 * L, 18_000 * L, 5), false, "offering less than proposed never needs approval");
  assert.equal(needsApproval(null, 25_000 * L, 5), false, "a first offer is the proposal");
  assert.deepEqual(basicDelta(19_500 * L, 21_000 * L), { paise: 1_500 * L, percent: 7.7 });
});

test("courier: not required without a hard copy; completed only when every return is received", () => {
  assert.equal(courierOverall(false, []), "not_required");
  assert.equal(courierOverall(true, []), "to_be_sent");
  assert.equal(courierOverall(true, [{ direction: "outbound", status: "sent" }]), "sent");
  assert.equal(courierOverall(true, [{ direction: "outbound", status: "delivered" }]), "awaited");
  assert.equal(courierOverall(true, [{ direction: "outbound", status: "delivered" }, { direction: "return", status: "return_sent" }]), "return_sent");
  assert.equal(courierOverall(true, [{ direction: "outbound", status: "delivered" }, { direction: "return", status: "received" }]), "completed");
  assert.equal(courierOverall(true, [{ direction: "outbound", status: "issue" }, { direction: "return", status: "received" }]), "issue", "an issue anywhere is the answer");
});

test("employment documents move one step at a time", () => {
  assert.equal(nextEmpDocStep("prepared"), "approved");
  assert.equal(nextEmpDocStep("sent"), "signed");
  assert.equal(nextEmpDocStep("filed"), null);
});

test("templates: placeholders fill from the offer; an unknown one stays visible", () => {
  assert.equal(fillTemplate("Dear {{name}}, {{ basic }}.", { name: "Kiran", basic: "₹20,000 a month" }), "Dear Kiran, ₹20,000 a month.");
  assert.equal(fillTemplate("{{bonus}}", {}), "{{bonus}}");
  assert.deepEqual(unknownPlaceholders("{{name}} {{bonus}} {{bonus}}"), ["bonus"]);
});

const base: OnboardingFacts = {
  appStatus: "in_progress",
  stageType: "compensation",
  pastGate: true,
  offer: null,
  docs: { mandatoryOpen: 0, requestedOpen: 0, underReview: 0 },
  bgv: { required: true, status: "clear" },
  empDocs: { required: 5, signed: 5 },
  courier: "completed",
  assets: { applicable: 6, issued: 6, acknowledgedNeeded: 6, acknowledged: 6 },
  training: null,
  onboardingCompleted: false,
};

test("the PRD status is read off the records, in the flow's order", () => {
  assert.equal(onboardingStatus({ ...base, offer: { status: "draft", approvalStatus: "pending" } }), "compensation_discussion");
  assert.equal(onboardingStatus({ ...base, offer: { status: "issued", approvalStatus: "not_needed" } }), "awaiting_acceptance");
  const accepted = { ...base, offer: { status: "accepted", approvalStatus: "not_needed" }, stageType: "document_collection" };
  assert.equal(onboardingStatus({ ...accepted, docs: { mandatoryOpen: 3, requestedOpen: 3, underReview: 0 } }), "document_collection");
  assert.equal(onboardingStatus({ ...accepted, docs: { mandatoryOpen: 1, requestedOpen: 0, underReview: 1 } }), "verification");
  assert.equal(onboardingStatus({ ...accepted, bgv: { required: true, status: "in_progress" } }), "verification");
  assert.equal(onboardingStatus({ ...accepted, bgv: { required: false, status: "not_applicable" }, empDocs: { required: 5, signed: 3 } }), "employment_documents");
  assert.equal(onboardingStatus({ ...accepted, courier: "awaited" }), "courier_pending");
  assert.equal(onboardingStatus(accepted), "ready_to_provision");
  const hired = { ...accepted, appStatus: "hired", stageType: "checklist" };
  assert.equal(onboardingStatus({ ...hired, assets: { applicable: 6, issued: 6, acknowledgedNeeded: 6, acknowledged: 4 } }), "assets_pending");
  assert.equal(onboardingStatus({ ...hired, training: { enrolled: true, required: 13, passed: 4 } }), "training");
  assert.equal(onboardingStatus({ ...hired, training: { enrolled: true, required: 13, passed: 13 } }), "training_completed");
  assert.equal(onboardingStatus({ ...hired, onboardingCompleted: true }), "onboarding_completed");
  assert.equal(onboardingStatus({ ...base, appStatus: "on_hold" }), "on_hold");
  assert.equal(onboardingStatus({ ...base, appStatus: "withdrawn" }), "closed");
});

test("the seeded PRD versions are the onboarding flow, and pass the validator", () => {
  for (const def of [SALES_EXECUTIVE_V4, TELECALLER_V2, ACCOUNTS_EXECUTIVE_V3]) {
    assert.equal(isOnboardingFlow(def), true);
    const errors = blocking(validateBlueprint(def, { planKeys: new Set(["sales-executive-monthly"]), templateKeys: new Set(["offer-letter", "appointment-contract", "roles-responsibilities", "growth-plan", "policy-acknowledgement"]), trackKeys: new Set(["sales-executive-onboarding", "telecaller-onboarding", "accountant-onboarding"]) }));
    assert.deepEqual(errors, []);
  }
  assert.equal(isOnboardingFlow(SALES_EXECUTIVE), false, "v3 keeps the flow it was published with");
  assert.equal(ACCOUNTS_EXECUTIVE_V3.offer.incentiveApplicable, false, "an accountant's offer: incentive not applicable");
});

test("the validator refuses training before the account, and names it", () => {
  const bad = structuredClone(SALES_EXECUTIVE_V4);
  const t = bad.stages.findIndex((s) => s.type === "training");
  const [training] = bad.stages.splice(t, 1);
  bad.stages.splice(bad.stages.findIndex((s) => s.type === "system_setup"), 0, training);
  assert.ok(blocking(validateBlueprint(bad)).some((i) => /Training comes after Provision/.test(i.message)));
  const missing = blocking(validateBlueprint(SALES_EXECUTIVE_V4, { trackKeys: new Set() }));
  assert.ok(missing.some((i) => /has no published version/.test(i.message)), "a track that is not published blocks publishing");
});

test("gating: after Provision only a hired person moves, and no override skips the account", () => {
  const def = SALES_EXECUTIVE_V4;
  const setup = def.stages.find((s) => s.type === "system_setup")!.key;
  const kit = def.stages.find((s) => s.type === "checklist")!.key;
  const training = def.stages.find((s) => s.type === "training")!.key;
  assert.equal(isPostHireStage(def, kit), true);
  assert.equal(isPostHireStage(def, setup), false);
  const notHired = canMove(def, { status: "in_progress", stageKey: setup, currentOutcome: "pending" }, kit);
  assert.equal(notHired.ok, false);
  assert.equal(!notHired.ok && notHired.overridable, false, "provisioning cannot be overridden past");
  assert.equal(canMove(def, { status: "hired", stageKey: kit, currentOutcome: "pass" }, training).ok, true);
  const back = canMove(def, { status: "hired", stageKey: kit, currentOutcome: "pass" }, setup);
  assert.equal(back.ok, false, "a hired person does not go back into the pipeline");
});
