import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alreadyForwarded, canMove, captionProblem, checkRecipientIds, FORWARD_MAX, tally, titleProblem, uniqueIds } from "./forward";

describe("forward rules", () => {
  it("refuses an empty recipient list", () => {
    assert.equal(checkRecipientIds([]).ok, false);
    assert.equal(checkRecipientIds(["", "  "]).ok, false);
  });
  it("counts a repeated recipient once, keeping order", () => {
    assert.deepEqual(uniqueIds(["a", "b", "a", " b ", "c"]), ["a", "b", "c"]);
    const r = checkRecipientIds(["a", "a", "b"]);
    assert.ok(r.ok && r.ids.length === 2);
  });
  it("caps the list", () => {
    const ids = Array.from({ length: FORWARD_MAX + 1 }, (_, i) => `c${i}`);
    assert.equal(checkRecipientIds(ids).ok, false);
    assert.equal(checkRecipientIds(ids.slice(0, FORWARD_MAX)).ok, true);
  });
  it("separates repeats from fresh recipients", () => {
    assert.deepEqual(alreadyForwarded(["a", "b", "c"], new Set(["b"])), { fresh: ["a", "c"], repeats: ["b"] });
  });
  it("validates title and caption", () => {
    assert.ok(titleProblem(" "));
    assert.equal(titleProblem("Diwali offer"), null);
    assert.ok(captionProblem("x".repeat(1001)));
    assert.equal(captionProblem("hello"), null);
  });
  it("allows moving status but not to itself", () => {
    assert.equal(canMove("pending", "sent"), true);
    assert.equal(canMove("sent", "sent"), false);
  });
  it("tallies", () => {
    assert.deepEqual(tally(["sent", "sent", "pending", "skipped"]), { pending: 1, opened: 0, sent: 2, skipped: 1, total: 4 });
  });
});
