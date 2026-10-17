import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { VERIFICATION_FAILED_CODE, REOPEN_REASONS, LOST_REASONS } from "../lead-labels";
import { ladderFor } from "./lead-ladder";
import { isReopenTransition, reopenNote, reopenTarget } from "./lead-reopen";

const REOPEN_NOTE_PREFIX = "Reopened from Lost";

describe("where a Lost lead comes back", () => {
  test("to the rung it was lost from, when that rung is still on its ladder", () => {
    const t = reopenTarget({ lostFrom: "qualification", salesType: "direct", lostReason: "price" });
    assert.equal(t.stage, "qualification");
    assert.equal(t.basis, "same_rung");
  });

  test("a failed verification returns to Prospect, never further and never 'verified'", () => {
    for (const salesType of ["direct", "third_party", "distributor"] as const) {
      const t = reopenTarget({ lostFrom: "qualification", salesType, lostReason: VERIFICATION_FAILED_CODE });
      assert.equal(t.stage, "prospect", salesType);
      assert.equal(t.basis, "verification_failed");
    }
  });

  test("a failed verification on a ladder with no Prospect rung falls to the foot, not an invalid state", () => {
    const t = reopenTarget({ lostFrom: "contacted", salesType: null, lostReason: VERIFICATION_FAILED_CODE });
    assert.equal(t.stage, ladderFor(null)[0]);
  });

  test("a rung the ladder no longer has starts again at the foot of the CURRENT ladder", () => {
    // Lost from a distributor-only rung, then re-typed as a direct sale.
    const t = reopenTarget({ lostFrom: "management_review", salesType: "direct", lostReason: "price" });
    assert.equal(t.stage, ladderFor("direct")[0]);
    assert.equal(t.basis, "ladder_changed");
  });

  test("on_hold is on no ladder, so it too starts at the foot", () => {
    const t = reopenTarget({ lostFrom: "on_hold", salesType: "direct", lostReason: "price" });
    assert.equal(t.stage, ladderFor("direct")[0]);
  });

  test("no closing transition on record (a legacy lead) starts at the foot rather than a guess", () => {
    const t = reopenTarget({ lostFrom: null, salesType: "direct", lostReason: "price" });
    assert.equal(t.stage, ladderFor("direct")[0]);
    assert.equal(t.basis, "no_record");
  });

  test("a lead that had reached the rung that makes it a customer comes back one rung BELOW it", () => {
    const direct = reopenTarget({ lostFrom: "second_order", salesType: "direct", lostReason: "price" });
    assert.equal(direct.stage, "payment");
    assert.equal(direct.basis, "on_the_book");
    const dist = reopenTarget({ lostFrom: "distributor_approval", salesType: "distributor", lostReason: "price" });
    assert.equal(dist.stage, "commercial_discussion");
  });

  test("whatever it returns, the rung is on the lead's own ladder and is never Customer", () => {
    for (const salesType of ["direct", "third_party", "distributor", null] as const) {
      for (const lostFrom of [null, ...ladderFor("direct"), ...ladderFor("distributor"), "on_hold", "won"] as const) {
        for (const lostReason of ["price", VERIFICATION_FAILED_CODE]) {
          const t = reopenTarget({ lostFrom, salesType, lostReason });
          assert.ok(ladderFor(salesType).includes(t.stage), `${salesType}/${lostFrom}/${lostReason} -> ${t.stage}`);
          assert.notEqual(t.stage, "customer");
          assert.notEqual(t.stage, "second_order");
          assert.notEqual(t.stage, "active_distributor");
        }
      }
    }
  });
});

describe("the words a reopen leaves behind", () => {
  test("the note says it was a reopen, why, what was lost for and that it left the archive", () => {
    const n = reopenNote({
      reasonLabel: "Customer ready to purchase",
      note: "Rang us on Monday",
      previousLostReason: "Price",
      restoredFromArchive: true,
    });
    assert.ok(n.startsWith(REOPEN_NOTE_PREFIX));
    for (const part of ["Customer ready to purchase", "Rang us on Monday", "Previously lost: Price", "archive"]) {
      assert.ok(n.includes(part), part);
    }
  });

  test("only a move OUT of lost is a reopen", () => {
    assert.equal(isReopenTransition({ fromStage: "lost", toStage: "qualification" }), true);
    assert.equal(isReopenTransition({ fromStage: "qualification", toStage: "lost" }), false);
    assert.equal(isReopenTransition({ fromStage: null, toStage: "suspect" }), false);
  });
});

describe("the configured list", () => {
  test("is coded, ends in Other, and shares no code with the loss list by accident", () => {
    assert.ok(REOPEN_REASONS.length >= 5);
    assert.equal(REOPEN_REASONS[REOPEN_REASONS.length - 1].code, "other");
    assert.equal(new Set(REOPEN_REASONS.map((r) => r.code)).size, REOPEN_REASONS.length);
    const lost = new Set(LOST_REASONS.map((r) => r.code));
    const shared = REOPEN_REASONS.map((r) => r.code).filter((c) => lost.has(c) && c !== "other");
    assert.deepEqual(shared, []);
  });
});
