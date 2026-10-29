import test from "node:test";
import assert from "node:assert/strict";
import {
  READINESS_OVERRIDE_REASONS,
  READINESS_TARGET,
  isPositiveAnswer,
  readReadiness,
  readinessLocked,
  readinessReasonLabel,
} from "@/lib/verification-readiness";

test("only a clear yes is positive", () => {
  for (const yes of ["Yes", "yes", "  Y", "true", "Yes — next week", "YES."]) assert.equal(isPositiveAnswer(yes), true, yes);
  for (const not of ["", "  ", "No", "not yet", "maybe", "Yesterday", "ready", null, undefined]) {
    assert.equal(isPositiveAnswer(not as string | undefined), false, String(not));
  }
});

test("no positive answer is no choice, and no move", () => {
  assert.deepEqual(readReadiness({}), { ok: true, choice: null });
  assert.deepEqual(readReadiness({ ready_for_trial: "No", ready_for_order: "not yet" }), { ok: true, choice: null });
});

test("exactly one positive answer is the choice", () => {
  assert.deepEqual(readReadiness({ ready_for_trial: "Yes" }), { ok: true, choice: "trial" });
  assert.deepEqual(readReadiness({ ready_for_commercial: "Yes", ready_for_trial: "No" }), { ok: true, choice: "rates" });
  assert.deepEqual(readReadiness({ ready_for_order: "yes please" }), { ok: true, choice: "order" });
});

test("two or three positive answers are refused, never silently resolved", () => {
  for (const answers of [
    { ready_for_trial: "Yes", ready_for_commercial: "Yes" },
    { ready_for_commercial: "Yes", ready_for_order: "Yes" },
    { ready_for_trial: "Yes", ready_for_order: "Yes" },
    { ready_for_trial: "Yes", ready_for_commercial: "Yes", ready_for_order: "Yes" },
  ]) {
    const r = readReadiness(answers);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /one of the three/i);
  }
});

test("a screen locks the OTHER rows when one is positive, and never the positive one", () => {
  const answers = { ready_for_commercial: "Yes" };
  assert.equal(readinessLocked("ready_for_trial", answers), true);
  assert.equal(readinessLocked("ready_for_order", answers), true);
  assert.equal(readinessLocked("ready_for_commercial", answers), false, "clearing it is how the choice is changed");
  assert.equal(readinessLocked("ready_for_trial", {}), false, "nothing positive locks nothing");
  assert.equal(readinessLocked("ready_for_trial", { ready_for_commercial: "No" }), false);
  assert.equal(readinessLocked("current_product", answers), false, "other questions are never locked");
});

test("each choice goes where the business rule says", () => {
  assert.equal(READINESS_TARGET.trial.to, "sample_trial");
  assert.equal(READINESS_TARGET.rates.to, "negotiation");
  assert.match(READINESS_TARGET.rates.note, /Sample not needed — customer ready for rates and terms/);
  /* an order is NOT a jump to 1st Order: that rung needs a real order */
  assert.equal(READINESS_TARGET.order.to, "negotiation");
  assert.equal(READINESS_TARGET.order.nextAction, "Take the order");
  assert.equal(READINESS_TARGET.trial.nextAction, undefined);
  assert.equal(READINESS_TARGET.rates.nextAction, undefined);
});

test("every reason a readiness move uses is named, so the audit trail reads in words", () => {
  const codes = Object.values(READINESS_TARGET).map((t) => t.reasonCode);
  for (const code of codes) assert.ok(READINESS_OVERRIDE_REASONS.some((r) => r.code === code), code);
  assert.equal(new Set(READINESS_OVERRIDE_REASONS.map((r) => r.code)).size, READINESS_OVERRIDE_REASONS.length);
  assert.match(readinessReasonLabel("readiness_sample_not_needed") ?? "", /Sample not needed/);
  assert.equal(readinessReasonLabel("recorded_late"), null);
});
