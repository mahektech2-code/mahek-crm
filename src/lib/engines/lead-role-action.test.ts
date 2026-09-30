/**
 * §7, pinned — and the assertion that matters most is the boring one: every
 * stage on every ladder answers every vantage with a sentence.
 *
 * A stage added without a line in the table does not fail anything at runtime.
 * It falls through to "no action for you on this lead", which is a real and
 * reasonable answer for most vantages and a silent lie for the one whose job
 * that rung IS — a back office team that stops being told to dispatch samples
 * because somebody added a rung above the one they read. That is the shape of
 * bug this file exists to make loud.
 *
 * Pure, like the engine: no database, no clock.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ALL_LEAD_STAGES } from "../lead-labels";
import type { LeadStage } from "../lead-labels";
import { DIRECT_LADDER, DISTRIBUTOR_LADDER, THIRD_PARTY_LADDER } from "./lead-ladder";
import { isOnQueueFor, roleAction } from "./lead-role-action";
import type { LeadActionFacts, LeadVantage } from "./lead-role-action";

const VANTAGES: LeadVantage[] = [
  "salesman",
  "calling_desk",
  "sales_manager",
  "management",
  "back_office",
];

function facts(stage: LeadStage, over: Partial<LeadActionFacts> = {}): LeadActionFacts {
  return {
    stage,
    salesType: "direct",
    hasCommitment: false,
    hasOrder: false,
    sampleAwaitingDispatch: false,
    ...over,
  };
}

describe("every stage answers every vantage", () => {
  for (const stage of ALL_LEAD_STAGES) {
    for (const vantage of VANTAGES) {
      test(`${stage} · ${vantage}`, () => {
        const action = roleAction(facts(stage), vantage);
        assert.ok(action.label.length > 0, "an empty instruction is not an instruction");
        assert.ok(
          ["brand", "warn", "danger", "muted"].includes(action.tone),
          `unknown tone ${action.tone}`,
        );
        /* A muted sentence is a statement that there is nothing to do, so it
         * must never also claim to be work. The pair drives queue membership
         * and the two disagreeing would put a lead on a list under a sentence
         * saying it does not belong there. */
        if (action.tone === "muted") {
          assert.equal(action.actionable, false, `${stage}/${vantage} is muted AND actionable`);
        }
      });
    }
  }
});

describe("no rung on any ladder falls through", () => {
  /* The fall-through is legitimate for a vantage a rung genuinely excludes —
   * management on `payment` — but never for ALL FIVE at once, which is what a
   * rung nobody wrote a line for looks like. */
  const everyRung = new Set<LeadStage>([
    ...DIRECT_LADDER,
    ...THIRD_PARTY_LADDER,
    ...DISTRIBUTOR_LADDER,
  ]);
  for (const stage of everyRung) {
    test(stage, () => {
      const answered = VANTAGES.map((v) => roleAction(facts(stage), v).label);
      const unwritten = answered.filter((l) => l === "No action for you on this lead");
      assert.notEqual(
        unwritten.length,
        VANTAGES.length,
        `${stage} has no line in the §7 table for anybody`,
      );
    });
  }
});

describe("§3.4 — negotiation forks on the commitment, and only for the manager", () => {
  test("no commitment: the manager supports the conversation", () => {
    const a = roleAction(facts("negotiation"), "sales_manager");
    assert.equal(a.label, "Support negotiation");
    assert.equal(a.tone, "warn");
  });

  test("commitment on file: the manager closes it, in danger tone", () => {
    const a = roleAction(facts("negotiation", { hasCommitment: true }), "sales_manager");
    assert.equal(a.label, "Confirm actual order");
    assert.equal(a.tone, "danger");
  });

  test("a real order ends the asking", () => {
    const a = roleAction(
      facts("negotiation", { hasCommitment: true, hasOrder: true }),
      "sales_manager",
    );
    assert.equal(a.label, "Support negotiation");
  });

  test("the salesman's verb does not move with it", () => {
    const without = roleAction(facts("negotiation"), "salesman");
    const with_ = roleAction(facts("negotiation", { hasCommitment: true }), "salesman");
    assert.deepEqual(without, with_);
  });
});

describe("scope of each vantage, as §7 states it", () => {
  test("management is given a verb on exactly the three approval rungs", () => {
    const acting = ALL_LEAD_STAGES.filter(
      (s) => roleAction(facts(s), "management").actionable,
    );
    assert.deepEqual(acting.sort(), [
      "commercial_discussion",
      "distributor_approval",
      "management_review",
    ]);
  });

  test("the calling desk never reaches past the early rungs", () => {
    const acting = ALL_LEAD_STAGES.filter((s) => roleAction(facts(s), "calling_desk").actionable);
    /* Suspect and its legacy twin (the calls), and Qualification and its legacy
     * twin — which is the Telecaller's to complete once the Sales Manager has
     * verified the Prospect. NOT Prospect: the desk waits there. `second_order`
     * used to be on this list and is the cell the engine file argues about at
     * length. */
    assert.deepEqual(acting.sort(), ["new", "qualification", "qualified", "suspect"]);
  });

  describe("Prospect → Qualification, with the Telecaller as owner", () => {
    test("at Prospect the Telecaller WAITS and the Sales Manager makes the call", () => {
      for (const stage of ["prospect", "contacted"] as LeadStage[]) {
        const desk = roleAction(facts(stage), "calling_desk");
        assert.equal(desk.label, "Awaiting Sales Manager verification", stage);
        assert.equal(desk.actionable, false, stage);
        const manager = roleAction(facts(stage), "sales_manager");
        assert.equal(manager.label, "Make the verification call", stage);
        assert.equal(manager.actionable, true, stage);
      }
    });

    test("nothing offers the Telecaller a verification — the misleading label is gone", () => {
      for (const stage of ALL_LEAD_STAGES) {
        for (const v of [undefined, true]) {
          assert.doesNotMatch(
            roleAction(facts(stage, { verified: v }), "calling_desk").label,
            /verification call support/i,
            stage,
          );
        }
      }
    });

    test("THERE IS NO SALESMAN — he has no action at Prospect or Qualification", () => {
      for (const stage of ["prospect", "contacted", "qualification", "qualified"] as LeadStage[]) {
        const a = roleAction(facts(stage), "salesman");
        assert.equal(a.actionable, false, stage);
        assert.equal(a.label, "No action for you on this lead", stage);
      }
    });

    test("at Qualification the Telecaller has a job, then a wait, then the manager's word", () => {
      const stage = "qualification" as LeadStage;
      const job = roleAction(facts(stage), "calling_desk");
      assert.deepEqual([job.label, job.actionable], ["Complete qualification", true]);

      const waiting = roleAction(facts(stage, { qualificationComplete: true }), "calling_desk");
      assert.deepEqual([waiting.label, waiting.actionable], ["Awaiting Sales Manager review", false]);

      for (const review of ["incomplete", "clarification"] as const) {
        const back = roleAction(facts(stage, { qualificationComplete: true, qualificationReview: review }), "calling_desk");
        assert.deepEqual([back.label, back.actionable], ["Answer the Sales Manager's note", true], review);
      }

      const done = roleAction(facts(stage, { qualificationComplete: true, qualificationReview: "verified" }), "calling_desk");
      assert.deepEqual([done.label, done.actionable], ["Request the sample", true]);
    });

    test("the manager reviews only a qualification the Telecaller has finished", () => {
      const stage = "qualification" as LeadStage;
      assert.equal(roleAction(facts(stage), "sales_manager").actionable, false);
      const ready = roleAction(facts(stage, { qualificationComplete: true }), "sales_manager");
      assert.deepEqual([ready.label, ready.actionable], ["Review qualification", true]);
      const verified = roleAction(facts(stage, { qualificationComplete: true, qualificationReview: "verified" }), "sales_manager");
      assert.equal(verified.actionable, false);
    });
  });

  test("the repeat-order rung is not the calling desk's", () => {
    const a = roleAction(facts("second_order"), "calling_desk");
    assert.equal(a.label, "No calling-desk action");
    assert.equal(a.actionable, false);
    /* And the manager's verb on that rung is untouched, because the two cells
     * carried the same words and only one of them was wrong. */
    assert.equal(roleAction(facts("second_order"), "sales_manager").label, "Repeat-order call");
  });

  test("the back office is silent on every rung before the sample", () => {
    for (const stage of ["suspect", "qualification", "negotiation"] as LeadStage[]) {
      assert.equal(
        roleAction(facts(stage), "back_office").label,
        "Nothing operational pending",
        stage,
      );
    }
  });

  test("except at Prospect, where the GST number is theirs and nobody else's", () => {
    /* The one cell this engine does not take from §7's table, and the engine
     * file carries the argument: §2 and §11.6 both give GST validation to the
     * back office, and it is the rung qualification is blocked on. Pinned by
     * name so the divergence cannot be undone by accident — reversing it is a
     * decision somebody makes here, having read why. */
    for (const stage of ["prospect", "contacted"] as LeadStage[]) {
      const a = roleAction(facts(stage), "back_office");
      assert.equal(a.label, "Validate GST number", stage);
      assert.equal(a.actionable, true, stage);
    }
  });

  test("management on a distributor candidate is told there is a track, not nothing", () => {
    /* §7's note, second half — the half `facts.salesType` exists for. */
    for (const stage of ["suspect", "prospect", "qualification"] as LeadStage[]) {
      assert.equal(
        roleAction(facts(stage, { salesType: "distributor" }), "management").label,
        "Monitor distributor track",
        stage,
      );
      assert.equal(
        roleAction(facts(stage), "management").label,
        "No approval pending",
        stage,
      );
    }
  });

  test("and it is still only words: neither answer is on anybody's queue", () => {
    const acting = ALL_LEAD_STAGES.filter(
      (s) => roleAction(facts(s, { salesType: "distributor" }), "management").actionable,
    );
    assert.deepEqual(acting.sort(), [
      "commercial_discussion",
      "distributor_approval",
      "management_review",
    ]);
  });

  test("a sample waiting to go is the back office's, in danger tone", () => {
    const a = roleAction(facts("sample_trial", { sampleAwaitingDispatch: true }), "back_office");
    assert.equal(a.label, "Dispatch sample");
    assert.equal(a.tone, "danger");
  });
});

describe("closure reads the same to everybody", () => {
  test("lost", () => {
    for (const v of VANTAGES) {
      const a = roleAction(facts("lost"), v);
      assert.equal(a.label, "Lost — no action");
      assert.equal(a.actionable, false);
    }
  });

  test("on hold says parked rather than lost", () => {
    for (const v of VANTAGES) {
      const a = roleAction(facts("on_hold"), v);
      assert.match(a.label, /parked, not lost/);
      assert.equal(a.actionable, false);
    }
  });

  test("customer names the hand-off rather than a verb", () => {
    for (const v of VANTAGES) {
      const a = roleAction(facts("customer"), v);
      assert.match(a.label, /Call Log/);
      assert.equal(a.actionable, false);
    }
  });
});

describe("queue membership believes the sentence", () => {
  test("it is exactly actionable, never a second reading", () => {
    for (const stage of ALL_LEAD_STAGES) {
      for (const v of VANTAGES) {
        assert.equal(
          isOnQueueFor(facts(stage), v),
          roleAction(facts(stage), v).actionable,
          `${stage}/${v}`,
        );
      }
    }
  });
});
