import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_BULK_HOLD, bulkStagePayload, bulkStageReady, pickableLostReasons } from "./lead-bulk-stage";
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

describe("bulk Change stage → On hold", () => {
  const holdReasons = [
    { code: "shutdown", label: "Plant shutdown" },
    { code: "other", label: "Other" },
  ];
  const full = { remarks: "", resumeDate: "2026-12-01", actionText: "Ring the buyer", actionDate: "2026-12-02" };

  test("Apply needs a listed code, a resume day, a next action and its day", () => {
    assert.equal(bulkStageReady("on_hold", "", holdReasons, full), false);
    assert.equal(bulkStageReady("on_hold", "not_listed", holdReasons, full), false);
    assert.equal(bulkStageReady("on_hold", "shutdown", holdReasons, full), true);
    assert.equal(bulkStageReady("on_hold", "shutdown", holdReasons, { ...full, resumeDate: "" }), false);
    assert.equal(bulkStageReady("on_hold", "shutdown", holdReasons, { ...full, actionText: "  " }), false);
    assert.equal(bulkStageReady("on_hold", "shutdown", holdReasons, { ...full, actionDate: "" }), false);
    assert.equal(bulkStageReady("on_hold", "shutdown", holdReasons, EMPTY_BULK_HOLD), false);
    assert.equal(bulkStageReady("on_hold", "shutdown", holdReasons), false, "no answers at all");
  });

  test("Other also needs the remarks", () => {
    assert.equal(bulkStageReady("on_hold", "other", holdReasons, full), false);
    assert.equal(bulkStageReady("on_hold", "other", holdReasons, { ...full, remarks: "  " }), false);
    assert.equal(bulkStageReady("on_hold", "other", holdReasons, { ...full, remarks: "Owner abroad" }), true);
  });

  test("a park carries its code, trimmed remarks, resume day and next action — and no owner", () => {
    assert.deepEqual(bulkStagePayload(["a", "b"], "on_hold", "shutdown", "ignored", { ...full, remarks: "  Plant shut " }), {
      customerIds: ["a", "b"],
      to: "on_hold",
      reasonCode: "shutdown",
      hold: { reason: "Plant shut", resumeDate: "2026-12-01" },
      nextAction: { action: "Ring the buyer", date: "2026-12-02" },
    });
    assert.equal(bulkStagePayload(["a"], "on_hold", "shutdown", "", full).hold?.reason, undefined, "blank remarks are not sent");
    assert.equal("ownerId" in (bulkStagePayload(["a"], "on_hold", "shutdown", "", full).nextAction ?? {}), false);
  });

  test("other destinations are unaffected by a park's answers", () => {
    assert.equal(bulkStageReady("contacted", "", holdReasons, EMPTY_BULK_HOLD), true);
    assert.deepEqual(bulkStagePayload(["a"], "contacted", "shutdown", "x", full), { customerIds: ["a"], to: "contacted" });
  });
});
