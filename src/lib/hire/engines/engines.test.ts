import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, graceProblem, scoreCalc, scoreFixed, stageResult, competencyRollup, confidenceWord } from "./scoring";
import { canMove } from "./gating";
import { blocking, validateBlueprint } from "./validator";
import { findDuplicates, maskNumber, nameSimilarity, normalisePhone } from "./identity";
import { adverseImpact, calibrate, correlation } from "./fairness";
import { SEED_BLUEPRINTS, SALES_EXECUTIVE, WAREHOUSE_SUPERVISOR } from "../seed/blueprints";
import type { CalcRule } from "../blueprint-types";

const stage = (k: string) => SALES_EXECUTIVE.stages.find((s) => s.key === k)!;
const question = (s: string, k: string) => stage(s).questions.find((q) => q.key === k)!;

test("the normalised formula is the AppSheet app's: earned ÷ max × 100", () => {
  const l1 = stage("l1");
  const pts = Object.fromEntries(l1.questions.map((q) => [q.key, 8.5]));
  const r = stageResult(l1, pts);
  assert.equal(r.max, 80);
  assert.equal(r.earned, 68);
  assert.equal(r.normalised, 85);
  assert.equal(r.outcome, "pass");
});

test("D4: one threshold — 66 at Level 2 is a fail, whatever the old 63 message said", () => {
  const l2 = stage("l2");
  const keys = l2.questions.map((q) => q.key);
  const pts: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 6.6]));
  const r = stageResult(l2, pts);
  assert.equal(r.normalised, 66);
  assert.equal(r.outcome, "fail");
});

test("a stage with an unscored question is pending, not failed", () => {
  const r = stageResult(stage("l1"), { q1: 10 });
  assert.equal(r.outcome, "pending");
  assert.equal(r.missing.length, 7);
});

test("grace is separate, bounded and reasoned — and a flip is flagged", () => {
  const l1 = stage("l1");
  const pts = Object.fromEntries(l1.questions.map((q) => [q.key, 6.75]));
  const r = stageResult(l1, pts, 3);
  assert.equal(r.normalised, 67.5);
  assert.equal(r.final, 70.5);
  assert.equal(r.outcome, "pass");
  assert.equal(r.graceFlipped, true);
  assert.match(graceProblem(l1, 3, "short") ?? "", /20 characters/);
  assert.match(graceProblem(l1, 7, "x".repeat(30)) ?? "", /between −5 and \+5/);
  assert.equal(graceProblem(l1, -2, "Answered the travel question well after a misheard first attempt."), null);
});

test("multi-select is capped at 10 (Level 1 responsibilities)", () => {
  const r = scoreFixed(question("l1", "q2"), ["a", "b", "c", "d"]);
  assert.equal(r.points, 10);
});

test("travel mode is cumulative with −10 for a private car", () => {
  assert.equal(scoreFixed(question("l3", "q9"), ["a", "b"]).points, 10);
  assert.equal(scoreFixed(question("l3", "q9"), ["b", "c"]).points, -5);
  assert.equal(scoreFixed(question("l3", "q9"), ["c"]).points, -10);
});

test("the boss-rating curve is preserved: 8 and 9 score 10, a 10 scores 0 (D13)", () => {
  const q = question("l3", "q10");
  assert.equal(scoreFixed(q, ["c"]).points, 10);
  assert.equal(scoreFixed(q, ["d"]).points, 10);
  assert.equal(scoreFixed(q, ["e"]).points, 0);
});

test("efficiency formula is exactly (visits × hours ÷ 8) × 10, and v3 caps it", () => {
  const rule = question("l3", "q8").calc!;
  const r = scoreCalc(rule, { visits: 9, hours: 9 });
  assert.equal(r.raw, 101.3);
  assert.equal(r.points, 10);
  const uncapped: CalcRule = { ...(rule as Extract<CalcRule, { kind: "formula" }>), cap: null };
  assert.equal(scoreCalc(uncapped, { visits: 9, hours: 9 }).points, 101.3);
});

test("D7: achievement between 60% and 90% scales 4 → 10 instead of scoring nothing", () => {
  const rule = question("l3", "q6").calc!;
  assert.equal(scoreCalc(rule, { pct: 59 }).points, 0);
  assert.equal(scoreCalc(rule, { pct: 60 }).points, 4);
  assert.equal(scoreCalc(rule, { pct: 84 }).points, 8.8);
  assert.equal(scoreCalc(rule, { pct: 95 }).points, 10);
});

test("D7: salary below ₹15,000 is scored", () => {
  assert.equal(scoreCalc(question("l1", "q4").calc!, { expected: 12000 }).points, 6);
  assert.equal(scoreCalc(question("l2", "q8").calc!, { salary: 16500 }).points, 10);
});

test("the formula reader does arithmetic and nothing else", () => {
  assert.equal(evaluate("(a + 2) * max(b, 3) / 2", { a: 1, b: 5 }), 7.5);
  assert.throws(() => evaluate("process.exit()", {}));
  assert.throws(() => evaluate("a + ", { a: 1 }));
});

test("every published seed blueprint passes its own validator", () => {
  for (const b of SEED_BLUEPRINTS.filter((x) => x.status === "published")) {
    const errs = blocking(validateBlueprint(b.definition));
    assert.deepEqual(errs, [], `${b.title}: ${errs.map((e) => e.message).join("; ")}`);
  }
});

test("the draft warehouse blueprint is blocked, for the reasons the studio shows", () => {
  const errs = blocking(validateBlueprint(WAREHOUSE_SUPERVISOR));
  assert.ok(errs.some((e) => /no score defined/.test(e.message)));
  assert.ok(errs.some((e) => /no competency/i.test(e.message)));
  assert.ok(errs.some((e) => /Not approved/.test(e.message)));
});

test("the validator refuses weights that do not total 100% and a gate after the offer", () => {
  const bad = structuredClone(SALES_EXECUTIVE);
  bad.competencies[0].weight = 0.5;
  const gate = bad.stages.findIndex((s) => s.type === "decision_gate");
  const [g] = bad.stages.splice(gate, 1);
  bad.stages.push(g);
  const msgs = blocking(validateBlueprint(bad)).map((e) => e.message).join(" | ");
  assert.match(msgs, /total 100%/);
  assert.match(msgs, /before documents and offer/);
});

test("D5: a failed or pending stage cannot be left without an override", () => {
  const def = SALES_EXECUTIVE;
  const v1 = canMove(def, { status: "in_progress", stageKey: "l1", currentOutcome: "fail" }, "l2");
  assert.equal(v1.ok, false);
  assert.equal(!v1.ok && v1.overridable, true);
  assert.equal(canMove(def, { status: "in_progress", stageKey: "l1", currentOutcome: "pass" }, "l2").ok, true);
  const skip = canMove(def, { status: "in_progress", stageKey: "l1", currentOutcome: "pass" }, "brf");
  assert.match(!skip.ok ? skip.why : "", /skips Level 2/);
  const back = canMove(def, { status: "in_progress", stageKey: "l2", currentOutcome: "pass" }, "l1");
  assert.equal(!back.ok && back.overridable, false);
  const gate = canMove(def, { status: "in_progress", stageKey: "gate", currentOutcome: "pass" }, "doc");
  assert.equal(!gate.ok && gate.route, "gate");
});

test("identity: phone is the key; names only propose", () => {
  assert.equal(normalisePhone("098220 41736"), "+919822041736");
  assert.equal(normalisePhone("+91 98220-41736"), "+919822041736");
  assert.equal(normalisePhone("12345"), null);
  assert.ok(nameSimilarity("Deepak Rathod", "Deepak Rathore") > 0.94);
  const m = findDuplicates({ name: "Deepak Rathod", phones: ["+919827240381"], email: null, location: "Indore" }, [
    { id: "a", name: "Deepak Rathore", phones: ["+919827240381"], email: null, location: "Indore" },
    { id: "b", name: "Deepak Rathore", phones: ["+919800000000"], email: null, location: "Indore" },
    { id: "c", name: "Suresh Patil", phones: ["+919800000001"], email: null, location: "Indore" },
  ]);
  assert.deepEqual(m.map((x) => [x.id, x.confidence]), [["a", "High"], ["b", "Moderate"]]);
  assert.equal(maskNumber("4417", "aadhaar"), "XXXX XXXX 4417");
});

test("four-fifths: a group under 0.8 of the top rate is flagged; small groups are said, not drawn", () => {
  const rows = adverseImpact([
    { group: "M", entered: 100, passed: 50 },
    { group: "F", entered: 40, passed: 14 },
    { group: "X", entered: 3, passed: 0 },
  ]);
  assert.equal(rows[1].ratio, 0.7);
  assert.equal(rows[1].flagged, true);
  assert.equal(rows[2].small, true);
  assert.equal(rows[2].flagged, false);
});

test("calibration and correlation", () => {
  const rows = [
    ...Array.from({ length: 6 }, () => ({ interviewer: "A", score: 90, grace: 2, aiAccepted: 3, aiTotal: 3 })),
    ...Array.from({ length: 6 }, () => ({ interviewer: "B", score: 70, grace: 0, aiAccepted: 1, aiTotal: 3 })),
  ];
  const c = calibrate(rows);
  assert.equal(c.panelMean, 80);
  assert.equal(c.stats.find((s) => s.interviewer === "A")!.label, "Lenient");
  assert.equal(c.stats.find((s) => s.interviewer === "A")!.agreement, 1);
  assert.equal(correlation([[1, 2], [2, 4], [3, 6], [4, 8], [5, 10]]), 1);
  assert.equal(correlation([[1, 2]]), null);
});

test("competency roll-up spans stages and confidence is words", () => {
  const r = competencyRollup(SALES_EXECUTIVE, { "l2.q1": 8, "l3.q1": 6, "l2.q4": 9 });
  assert.equal(r.scores.c1, 7);
  assert.equal(r.scores.c5, 9);
  assert.equal(confidenceWord(0.9), "High");
  assert.equal(confidenceWord(0.6), "Moderate");
  assert.equal(confidenceWord(0.2), "Low");
});
