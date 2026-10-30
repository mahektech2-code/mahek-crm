import { test } from "node:test";
import assert from "node:assert/strict";
import { callSteps, clampStep, firstStepWithError, stepOfField } from "./call-form-steps";

test("an order taken asks all five steps", () => {
  assert.deepEqual(callSteps({ orderReceived: false, takesProducts: true, hasNextStep: true }), [
    "happened",
    "outcome",
    "order",
    "next",
    "review",
  ]);
});

test("an outcome that takes no products skips the order", () => {
  assert.deepEqual(callSteps({ orderReceived: false, takesProducts: false, hasNextStep: true }), [
    "happened",
    "outcome",
    "next",
    "review",
  ]);
});

test("an order received has no outcome step, and always the order", () => {
  assert.deepEqual(callSteps({ orderReceived: true, takesProducts: false, hasNextStep: false }), [
    "happened",
    "order",
    "review",
  ]);
});

test("a field error opens the step that holds the field", () => {
  assert.equal(stepOfField("reasonDetail.amount"), "happened");
  assert.equal(stepOfField("outcomeDetail.reason"), "outcome");
  assert.equal(stepOfField("complaintDescription"), "outcome");
  assert.equal(stepOfField("lineDiscount.abc"), "order");
  assert.equal(stepOfField("opportunity.product"), "next");
  assert.equal(stepOfField("somethingElse"), null);
});

test("the earliest step with an error wins, and a step not asked falls to review", () => {
  const steps = callSteps({ orderReceived: false, takesProducts: false, hasNextStep: true });
  assert.equal(firstStepWithError(steps, ["nextActionDate", "outcomeDetail.x"]), "outcome");
  assert.equal(firstStepWithError(steps, ["orderDate"]), "review");
  assert.equal(firstStepWithError(steps, ["unknown"]), null);
});

test("a step that left the list moves back, never forward", () => {
  const steps = callSteps({ orderReceived: false, takesProducts: false, hasNextStep: true });
  assert.equal(clampStep(steps, "order"), "outcome");
  assert.equal(clampStep(steps, "next"), "next");
  const noNext = callSteps({ orderReceived: false, takesProducts: false, hasNextStep: false });
  assert.equal(clampStep(noNext, "next"), "outcome");
});
