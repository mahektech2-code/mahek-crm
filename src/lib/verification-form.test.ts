import test from "node:test";
import assert from "node:assert/strict";
import { VERIFICATION_FINDINGS, VERIFICATION_QUESTIONS } from "@/lib/lead-labels";
import {
  HIDDEN_FINDINGS,
  HIDDEN_QUESTIONS,
  REQUIRED_WHEN_VERIFIED,
  isActiveFinding,
  isActiveQuestion,
  missingRequiredAnswers,
} from "@/lib/verification-form";

const findingIds = VERIFICATION_FINDINGS.map((f) => f.id);
const questionIds = VERIFICATION_QUESTIONS.map((q) => q.id);

test("everything hidden is a real id, so a typo cannot hide nothing or the wrong thing", () => {
  for (const id of HIDDEN_FINDINGS) assert.ok(findingIds.includes(id), `${id} is not a finding`);
  for (const id of HIDDEN_QUESTIONS) assert.ok(questionIds.includes(id), `${id} is not a question`);
  for (const id of REQUIRED_WHEN_VERIFIED) assert.ok(questionIds.includes(id), `${id} is not a question`);
});

test("the form hides, never deletes: the full vocabulary is untouched", () => {
  assert.equal(findingIds.length, 10);
  assert.equal(questionIds.length, 17);
  assert.ok(findingIds.includes("contact_person") && findingIds.includes("decision_maker"));
  assert.ok(questionIds.includes("price_issue") && questionIds.includes("visited"));
});

test("the findings and questions that stay are exactly the intended ones", () => {
  assert.deepEqual(
    findingIds.filter(isActiveFinding),
    ["competitor", "monthly_litres", "potential", "required_product", "credit_days", "application", "customer_type", "buyer"],
  );
  assert.deepEqual(
    questionIds.filter(isActiveQuestion),
    ["current_product", "competitor", "monthly_requirement", "ready_for_trial", "ready_for_commercial", "ready_for_order"],
  );
});

test("the 'what is stopping them' section is gone entirely", () => {
  const objections = VERIFICATION_QUESTIONS.filter((q) => q.section === "objections").map((q) => q.id);
  assert.equal(objections.length, 5);
  assert.ok(objections.every((id) => !isActiveQuestion(id)));
});

test("the current product is required for a successful verification only", () => {
  assert.deepEqual(missingRequiredAnswers("verified", {}), ["current_product"]);
  assert.deepEqual(missingRequiredAnswers("verified", { current_product: "   " }), ["current_product"]);
  assert.deepEqual(missingRequiredAnswers("verified", { current_product: "Asian Paints PU" }), []);
  /* a follow-up cannot confirm it, and a false lead cannot be made to answer */
  assert.deepEqual(missingRequiredAnswers("follow_up", {}), []);
  assert.deepEqual(missingRequiredAnswers("not_qualified", {}), []);
  assert.deepEqual(missingRequiredAnswers(null, {}), []);
});

test("the remarks box is not a numbered question and keeps the server's note rule", async () => {
  const { readFileSync } = await import("node:fs");
  const screen = readFileSync("src/components/leads/record/verify/verify-screen.tsx", "utf8");
  const action = readFileSync("src/lib/actions/leads.ts", "utf8");
  /* drawn as a plain block under the result, never as a numbered Row */
  const at = screen.indexOf("Remarks / Next Action</span>");
  assert.ok(at > 0, "the remarks label is missing");
  assert.ok(!/verdictN\s*\+\s*1/.test(screen), "the note must not take a number after the result");
  assert.ok(!screen.slice(Math.max(0, at - 600), at).includes("<Row"), "remarks must not be drawn as a numbered Row");
  /* the note is still demanded for the two results that need it */
  assert.ok(/c\.outcome === "follow_up" && !c\.followUpNote\?\.trim\(\)/.test(action));
  assert.ok(/c\.outcome === "not_qualified" && !c\.followUpNote\?\.trim\(\)/.test(action));
});
