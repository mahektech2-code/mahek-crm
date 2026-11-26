import test from "node:test";
import assert from "node:assert/strict";
import { stopSkipVerdict, workPredatesMove } from "./field-day-rules";

test("a planned stop skips with its reason, trimmed", () => {
  assert.deepEqual(stopSkipVerdict("planned", "  Shop shut for a wedding "), {
    kind: "skip",
    reason: "Shop shut for a wedding",
  });
});

test("a skip with no reason is refused", () => {
  assert.equal(stopSkipVerdict("planned", "   ").kind, "refuse");
  assert.equal(stopSkipVerdict("planned", null).kind, "refuse");
});

test("a visited stop is never moved to skipped, and says so without refusing", () => {
  assert.deepEqual(stopSkipVerdict("visited", "Closed"), { kind: "noop", why: "already_visited" });
  /* Even with no reason — there is nothing to correct. */
  assert.deepEqual(stopSkipVerdict("visited", ""), { kind: "noop", why: "already_visited" });
});

test("a second skip changes nothing", () => {
  assert.deepEqual(stopSkipVerdict("skipped", "A different reason"), { kind: "noop", why: "already_skipped" });
});

const H = 3_600_000;

test("work before the move is accepted", () => {
  assert.equal(workPredatesMove(10 * H, 14 * H, 0), true);
});

test("work after the move is accepted only inside the grace", () => {
  assert.equal(workPredatesMove(15 * H, 14 * H, 0), false);
  assert.equal(workPredatesMove(15 * H, 14 * H, 2), true);
  assert.equal(workPredatesMove(17 * H, 14 * H, 2), false);
});

test("a shop with no recorded move away from him is never his", () => {
  assert.equal(workPredatesMove(1, null, 48), false);
  assert.equal(workPredatesMove(1, undefined, 48), false);
});

test("work with no instant proves nothing", () => {
  assert.equal(workPredatesMove(null, 14 * H, 48), false);
  assert.equal(workPredatesMove(Number.NaN, 14 * H, 48), false);
});

test("a negative grace is read as none", () => {
  assert.equal(workPredatesMove(15 * H, 14 * H, -5), false);
});
