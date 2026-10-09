import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { bulkStagePayload, bulkStageReady, pickableLostReasons } from "./lead-bulk-stage";
import { LOST_REASONS } from "./lead-labels";

const offered = pickableLostReasons(LOST_REASONS);

describe("bulk Change stage → Lost", () => {
  test("Apply is not ready for Lost until a listed reason is picked", () => {
    assert.equal(bulkStageReady("lost", "", offered), false);
    assert.equal(bulkStageReady("lost", "not_a_reason", offered), false);
    assert.equal(bulkStageReady("lost", "price", offered), true);
  });

  test("other destinations are unaffected by the reason", () => {
    assert.equal(bulkStageReady("contacted", "", offered), true);
  });

  test("the verification call's code is not offered to a person", () => {
    assert.ok(!offered.some((r) => r.code === "verification_failed"));
    assert.equal(bulkStageReady("lost", "verification_failed", offered), false);
    assert.ok(offered.length > 0);
  });

  test("the list comes from what is configured, not the literal", () => {
    const reworded = [{ code: "budget", label: "No budget" }];
    assert.equal(bulkStageReady("lost", "budget", pickableLostReasons(reworded)), true);
    assert.equal(bulkStageReady("lost", "price", pickableLostReasons(reworded)), false);
  });

  test("a loss carries its reason and trimmed note; other moves carry neither", () => {
    assert.deepEqual(bulkStagePayload(["a"], "lost", "price", "  too dear "), {
      customerIds: ["a"],
      to: "lost",
      reasonCode: "price",
      note: "too dear",
    });
    assert.equal(bulkStagePayload(["a"], "lost", "price", "  ").note, undefined);
    assert.deepEqual(bulkStagePayload(["a"], "contacted", "price", "x"), {
      customerIds: ["a"],
      to: "contacted",
    });
  });
});
