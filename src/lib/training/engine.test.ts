import { test } from "node:test";
import assert from "node:assert/strict";
import { canStartAttempt, drawAttempt, moduleProblems, moduleStates, prerequisites, progress, score, shuffle, trackProblems, type AttemptLite, type EventLite } from "./engine";
import type { ModuleDefinition, TrackDefinition } from "./types";
import { SEED_MODULES, SEED_TRACKS } from "../hire/seed/onboarding";

const NOW = Date.parse("2026-11-26T12:00:00+05:30");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

test("PRD §16: equal to the pass mark passes; below fails", () => {
  assert.deepEqual(score(8, 10, 80), { percent: 80, result: "passed" });
  assert.deepEqual(score(7, 10, 80), { percent: 70, result: "failed" });
  assert.deepEqual(score(8, 13, 62), { percent: 61.5, result: "failed" }, "61.5 is not rounded up into a pass");
  assert.equal(score(0, 0, 80).result, "failed");
});

test("shuffling is seeded: the same attempt draws the same order on every reload", () => {
  assert.deepEqual(shuffle([1, 2, 3, 4, 5, 6], 42), shuffle([1, 2, 3, 4, 5, 6], 42));
  assert.notDeepEqual(shuffle([1, 2, 3, 4, 5, 6, 7, 8], 1), shuffle([1, 2, 3, 4, 5, 6, 7, 8], 2));
  const def = SEED_MODULES.find((m) => m.key === "objections")!.definition;
  const a = drawAttempt({ ...def, questionsPerAttempt: 2 }, 7);
  assert.equal(a.length, 2);
  assert.deepEqual(a, drawAttempt({ ...def, questionsPerAttempt: 2 }, 7));
  assert.equal(new Set(a[0].optionOrder).size, a[0].optionOrder.length);
});

test("an unapproved or inactive question is never drawn, and blocks publishing when active", () => {
  const def: ModuleDefinition = structuredClone(SEED_MODULES[0].definition);
  def.questions[0] = { ...def.questions[0], ai: true, approved: false };
  def.questions[1] = { ...def.questions[1], active: false };
  const drawn = drawAttempt(def, 1).map((x) => x.questionKey);
  assert.ok(!drawn.includes(def.questions[0].key) && !drawn.includes(def.questions[1].key));
  assert.ok(moduleProblems(def).some((p) => /AI-drafted/.test(p)));
});

const track: TrackDefinition = {
  designations: [],
  sequential: true,
  completeWithinDays: 30,
  items: [
    { moduleKey: "a", required: true, after: null },
    { moduleKey: "b", required: true, after: null },
    { moduleKey: "ind", required: true, after: [] },
    { moduleKey: "c", required: false, after: null },
  ],
};
const minStudy = { a: 5, b: 5, ind: 0, c: 0 };
const studied = (k: string, minutesAgo: number, seconds = 600): EventLite => ({ moduleKey: k, kind: "studied", seconds, at: at(minutesAgo) });
const attempt = (k: string, no: number, minutesAgo: number, result: "passed" | "failed", pct: number): AttemptLite => ({ moduleKey: k, attemptNo: no, startedAt: at(minutesAgo + 10), submittedAt: at(minutesAgo), deadlineAt: null, result, scorePercent: pct });

test("PRD §17: sequential unlocking, with a module that runs alongside", () => {
  const pre = prerequisites(track);
  assert.deepEqual(pre.get("b"), ["a"]);
  assert.deepEqual(pre.get("ind"), [], "an explicit empty list runs alongside");
  assert.deepEqual(pre.get("c"), ["ind"], "null after an explicit item still means the one before it");
  const s = moduleStates(track, [], [], minStudy, NOW);
  assert.deepEqual(s.map((x) => x.state), ["available", "locked", "available", "locked"]);
});

test("study gate: the test opens only after the minimum study", () => {
  const s = moduleStates(track, [], [studied("a", 30, 120)], minStudy, NOW);
  assert.equal(s[0].state, "in_progress");
  assert.equal(canStartAttempt(s[0], 5).ok, false);
  const s2 = moduleStates(track, [], [studied("a", 30, 300)], minStudy, NOW);
  assert.equal(s2[0].state, "available");
  assert.equal(canStartAttempt(s2[0], 5).ok, true);
});

test("PRD §18: a fail is retraining — no retake until a trainer signs off AND the module is studied again", () => {
  const events = [studied("a", 120)];
  const failed = [attempt("a", 1, 60, "failed", 62)];
  let s = moduleStates(track, failed, events, minStudy, NOW);
  assert.equal(s[0].state, "retraining_required");
  assert.equal(s[1].state, "locked", "the next module stays locked");
  assert.equal(canStartAttempt(s[0], 5).ok, false);
  const signed: EventLite = { moduleKey: "a", kind: "retraining_signed_off", seconds: null, at: at(30) };
  s = moduleStates(track, failed, [...events, signed], minStudy, NOW);
  assert.equal(s[0].state, "retraining_required", "studying BEFORE the fail does not count again");
  s = moduleStates(track, failed, [...events, signed, studied("a", 10, 300)], minStudy, NOW);
  assert.equal(s[0].state, "retake_open");
  assert.equal(canStartAttempt(s[0], 5).ok, true);
  const signedBeforeFail: EventLite = { moduleKey: "a", kind: "retraining_signed_off", seconds: null, at: at(90) };
  assert.equal(moduleStates(track, failed, [...events, signedBeforeFail, studied("a", 10)], minStudy, NOW)[0].state, "retraining_required", "a sign-off from before the fail does not open the retake");
});

test("the retake passing unlocks the next module; history keeps both attempts", () => {
  const s = moduleStates(track, [attempt("a", 1, 60, "failed", 62), attempt("a", 2, 5, "passed", 85)], [studied("a", 120)], minStudy, NOW);
  assert.equal(s[0].state, "passed");
  assert.equal(s[0].attempts, 2);
  assert.equal(s[0].bestScore, 85);
  assert.equal(s[1].state, "available");
});

test("an open attempt is a test in progress until its deadline passes", () => {
  const open: AttemptLite = { moduleKey: "a", attemptNo: 1, startedAt: at(5), submittedAt: null, deadlineAt: new Date(NOW + 10 * 60_000).toISOString(), result: null, scorePercent: null };
  assert.equal(moduleStates(track, [open], [studied("a", 30)], minStudy, NOW)[0].state, "assessment_pending");
  const expired = { ...open, deadlineAt: new Date(NOW - 60_000).toISOString() };
  assert.notEqual(moduleStates(track, [expired], [studied("a", 30)], minStudy, NOW)[0].state, "assessment_pending");
});

test("progress counts required modules only", () => {
  const s = moduleStates(track, [attempt("a", 1, 5, "passed", 90), attempt("ind", 1, 5, "passed", 90)], [], minStudy, NOW);
  const p = progress(s);
  assert.equal(p.required, 3);
  assert.equal(p.passed, 2);
  assert.equal(p.percent, 67);
});

test("the seeded tracks and modules are publishable", () => {
  const keys = new Set(SEED_MODULES.map((m) => m.key));
  for (const t of SEED_TRACKS) assert.deepEqual(trackProblems(t.definition, keys), [], t.key);
  for (const m of SEED_MODULES) assert.deepEqual(moduleProblems(m.definition), [], m.key);
});
