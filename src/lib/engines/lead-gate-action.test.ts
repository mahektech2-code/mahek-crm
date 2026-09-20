import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mbosLeadStageEnum } from "@/db/schema";
import { gateAction, type LeadGateActionFacts } from "./lead-gate-action";
import type { LeadSalesType, LeadStage, SampleState } from "@/lib/lead-labels";

/* ---------------------------------------------------------------------------
 * §5 and §6 — every rung answers, and the answer is the one in the table.
 *
 * The failure this exists for is a rung that answers NOTHING: a record with no
 * way forward on it, which nobody reports as a bug because it looks like a
 * lead with nothing waiting on it. The switch in the engine has no `default`
 * and ends in a `never`, so a twenty-fourth rung fails the build — but the
 * type only guards the FILE, and a stage added to the union in `lead-labels`
 * and not to the enum, or the other way round, would slip past it. This walks
 * the ENUM, which is what the database will actually hold.
 * ------------------------------------------------------------------------- */

const ALL_STAGES = mbosLeadStageEnum.enumValues as readonly LeadStage[];

const LADDERS: readonly (LeadSalesType | null)[] = [
  null,
  "direct",
  "third_party",
  "distributor",
];

function facts(stage: LeadStage, over: Partial<LeadGateActionFacts> = {}): LeadGateActionFacts {
  return {
    stage,
    salesType: "direct",
    mustDecide: false,
    hasCommitment: false,
    hasOrder: false,
    sampleState: null,
    ...over,
  };
}

describe("gateAction covers every rung", () => {
  test("all 23 stages answer on all four ladders", () => {
    for (const stage of ALL_STAGES) {
      for (const salesType of LADDERS) {
        const a = gateAction(facts(stage, { salesType }));
        assert.ok(a.label.trim().length > 0, `${stage} / ${salesType} has no verb`);
        assert.ok(a.says.trim().length > 0, `${stage} / ${salesType} says nothing`);
        assert.ok(
          ["brand", "warn", "danger", "muted"].includes(a.tone),
          `${stage} / ${salesType} has a tone the pill cannot draw`,
        );
      }
    }
  });

  /**
   * A VERB IS NOT A RUNG NAME. The whole reason this file exists is that
   * "Advance" said less than the ladder above it already did, and a label that
   * is just the destination stage repeats the same mistake in longer words.
   */
  test("no rung answers with a bare stage name", () => {
    for (const stage of ALL_STAGES) {
      const a = gateAction(facts(stage));
      assert.notEqual(a.label.toLowerCase(), stage.replace(/_/g, " "));
    }
  });

  /**
   * `none` IS FOR THE STATES WITH NOWHERE TO GO, and only those. A rung that
   * quietly answers "nothing to press" is a lead somebody cannot move and
   * nobody can see why — which is the shape of the bug, wearing the shape of a
   * deliberate answer.
   */
  test("only the closed and the parked answer with no control", () => {
    const nowhere = ALL_STAGES.filter((s) => gateAction(facts(s)).control === "none");
    assert.deepEqual(
      [...nowhere].sort(),
      ["active_distributor", "customer", "lost", "on_hold", "won"],
    );
  });
});

describe("§5's forks are the ones the table names", () => {
  /* §5.5 — §7's own fork, and the single most consequential moment on the
     ladder. A commitment on file with no order against it is money left on the
     table, and it is the one state here that goes quiet by itself. */
  test("Negotiation with a commitment and no order is Confirm the actual order", () => {
    const a = gateAction(facts("negotiation", { hasCommitment: true }));
    assert.equal(a.control, "confirm_order");
    assert.equal(a.tone, "danger");
    assert.match(a.label, /confirm the actual order/i);
  });

  test("Negotiation with nothing promised asks for the forecast first", () => {
    const a = gateAction(facts("negotiation"));
    assert.equal(a.control, "record_commitment");
    assert.notEqual(a.tone, "danger");
  });

  test("Negotiation with an order on the record just moves the rung", () => {
    const a = gateAction(facts("negotiation", { hasCommitment: true, hasOrder: true }));
    assert.equal(a.control, "advance");
  });

  /* §5.3 against §6.2 — the same rung asks two different things, and one verb
     for both would send half the book to a form that does not apply. */
  test("Qualification is a sample on a shop and a review on a distributor", () => {
    assert.equal(gateAction(facts("qualification")).control, "request_sample");
    assert.equal(
      gateAction(facts("qualification", { salesType: "third_party" })).control,
      "request_sample",
    );
    assert.equal(
      gateAction(facts("qualification", { salesType: "distributor" })).control,
      "advance",
    );
  });

  /* §4 — the cap ASKS rather than refuses, so past it the verb changes and
     nothing is blocked. Both answers are moves the rules allow. */
  test("a Suspect past the cap is asked to decide, and is still not refused", () => {
    const before = gateAction(facts("suspect"));
    const after = gateAction(facts("suspect", { mustDecide: true }));
    assert.equal(before.control, "advance");
    assert.equal(after.control, "advance");
    assert.notEqual(before.label, after.label);
    assert.equal(after.tone, "danger");
  });

  /* §5.4 — three sub-states and three different people to chase. Drawn as one
     verb they look identical, which is exactly how a sample goes quiet. */
  test("the sample rung names who is being waited on", () => {
    const seen = new Set<string>();
    for (const state of ["requested", "approved", "dispatched"] as SampleState[]) {
      const a = gateAction(facts("sample_trial", { sampleState: state }));
      assert.ok(!seen.has(a.label), `two sample states share the verb "${a.label}"`);
      seen.add(a.label);
    }
    assert.equal(
      gateAction(facts("sample_trial", { sampleState: "approved" })).tone,
      "danger",
      "approved and unsent is stock nobody gave away against an opportunity nobody took",
    );
  });

  test("a refused or cancelled trial asks for a fresh sample rather than a chase", () => {
    for (const state of ["rejected", "cancelled", null] as (SampleState | null)[]) {
      assert.equal(
        gateAction(facts("sample_trial", { sampleState: state })).control,
        "request_sample",
        `${state} should send somebody back to the request form`,
      );
    }
  });

  test("Sample Received is the trial review, at the desk that holds the stock", () => {
    const a = gateAction(facts("sample_received"));
    assert.equal(a.control, "sample_desk");
    assert.match(a.label, /trial review/i);
  });

  /*
   * IT IS NOT A SECOND OPINION ABOUT THE GATE. §5.4's rule that a rejected
   * trial may not reach Negotiation is `lead-gates.ts`'s, and this engine is
   * given no trial outcome at all — so it cannot be asking it twice. The test
   * states that as a fact about the INPUT rather than about a result, because
   * that is the shape the drift would take: somebody adding the column here.
   */
  test("the trial verdict is not one of this engine's facts", () => {
    const keys = Object.keys(facts("sample_review"));
    assert.ok(!keys.some((k) => /outcome|verdict|approved/i.test(k)));
  });
});

describe("§6's two approvals are management's and say so", () => {
  test("both approval rungs point at the chain", () => {
    for (const stage of ["management_review", "distributor_approval"] as LeadStage[]) {
      const a = gateAction(facts(stage, { salesType: "distributor" }));
      assert.equal(a.control, "management_approval");
      assert.equal(a.tone, "danger");
    }
  });

  test("the paperwork rungs are plain moves and are drawn as such", () => {
    for (const stage of [
      "commercial_discussion",
      "distributor_agreement",
      "initial_stock_order",
    ] as LeadStage[]) {
      const a = gateAction(facts(stage, { salesType: "distributor" }));
      assert.equal(a.control, "advance");
      assert.notEqual(a.tone, "danger");
    }
  });
});
