/**
 * SAMPLE / TRIAL IS ONE PIPELINE STAGE WITH TWO STEPS INSIDE IT.
 *
 *   Step 1 — Sample Request: Sample requested?, Product, Sending date, Sending mode.
 *   Step 2 — Sample Received & Review: Has it been received?, then Quality,
 *            Vs. the Brand, Anything Else and the Verdict.
 *
 * These are the pure halves of that: what the ladder draws, what the two
 * questionnaires ask, and what the gate in front of Negotiation still demands.
 * The database halves (approval, dispatch and receipt staying intact, several
 * samples on one lead, server-side validation) are in the integration suites.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVE_FEEDBACK_FIELDS,
  FEEDBACK_FIELDS,
  SAMPLE_SENDING_MODES,
  feedbackLabel,
  isMeaningfulAnswer,
  stageLabel,
  trialReviewProblem,
  type LeadSalesType,
  type LeadStage,
} from "../lead-labels";
import { foldStage, ladderFor } from "./lead-ladder";
import { gateTo, type LeadGateInput } from "./lead-gates";

const SHOP_LADDERS: LeadSalesType[] = ["direct", "third_party"];

describe("two sample stages on the pipeline", () => {
  test("both shop ladders draw Sample / Trial, then Sample received & review, then Negotiation", () => {
    for (const type of SHOP_LADDERS) {
      const ladder = ladderFor(type);
      assert.equal(ladder.filter((s) => s === "sample_trial").length, 1, type);
      assert.equal(ladder.filter((s) => s === "sample_review").length, 1, type);
      assert.ok(!ladder.includes("sample_received"), `${type} still draws the older Sample Received`);
      assert.equal(ladder[ladder.indexOf("sample_trial") + 1], "sample_review", type);
      assert.equal(ladder[ladder.indexOf("sample_review") + 1], "negotiation", type);
    }
  });

  test("direct and third-party use the same single-stage shape", () => {
    assert.deepEqual([...ladderFor("direct")], [...ladderFor("third_party")]);
  });

  test("the distributor ladder has no sample stage at all", () => {
    assert.ok(!ladderFor("distributor").includes("sample_trial"));
  });

  test("a lead an older build left on sample_received reads as Sample received & review", () => {
    assert.equal(foldStage("sample_received" as LeadStage), "sample_review");
    assert.equal(stageLabel("sample_received"), stageLabel("sample_review"));
    assert.equal(stageLabel("sample_review"), "Sample received & review");
    assert.equal(stageLabel("sample_trial"), "Sample / trial");
  });
});

describe("Step 1 — Sample Request", () => {
  test("the sending mode has exactly two answers: Courier and Hand Delivery", () => {
    assert.deepEqual(
      SAMPLE_SENDING_MODES.map((m) => [m.code, m.label]),
      [
        ["courier", "Courier"],
        ["hand_delivery", "Hand Delivery"],
      ],
    );
  });
});

describe("Step 2 — Sample Received & Review", () => {
  test("a review asks exactly Quality, Vs. the Brand and Anything Else", () => {
    assert.deepEqual(
      ACTIVE_FEEDBACK_FIELDS.map((f) => f.label),
      ["Quality", "Vs. the Brand", "Anything Else"],
    );
  });

  test("Performance, Application, Drying and Price are no longer asked, and stay readable", () => {
    const asked = new Set(ACTIVE_FEEDBACK_FIELDS.map((f) => f.id as string));
    for (const gone of ["performance", "application", "drying", "priceFeedback"]) {
      assert.ok(!asked.has(gone), `${gone} is still asked`);
      assert.ok(
        FEEDBACK_FIELDS.some((f) => f.id === gone),
        `${gone} must stay in the historical vocabulary so a past review still reads`,
      );
    }
    assert.equal(feedbackLabel("drying"), "Drying");
    assert.equal(feedbackLabel("competitorComparison"), "Vs. the Brand");
  });

  test("the verdict is mandatory", () => {
    assert.match(trialReviewProblem({ quality: "Dries well" }, null) ?? "", /verdict/i);
    assert.match(trialReviewProblem({ quality: "Dries well" }, undefined) ?? "", /verdict/i);
  });

  test("an empty review is refused, whatever the verdict", () => {
    for (const verdict of ["approved", "more_testing", "rejected"] as const) {
      assert.ok(trialReviewProblem({}, verdict), `${verdict} with nothing written was accepted`);
      assert.ok(
        trialReviewProblem({ quality: "   ", competitorComparison: "", otherComments: "\n" }, verdict),
        `${verdict} with blank boxes was accepted`,
      );
    }
  });

  test("a keystroke is not feedback", () => {
    for (const noise of [".", "-", "ok", "  ", "!!!", "—"]) {
      assert.equal(isMeaningfulAnswer(noise), false, JSON.stringify(noise));
    }
    assert.equal(isMeaningfulAnswer("Dries in 2 hours"), true);
    assert.equal(isMeaningfulAnswer("बहुत अच्छा"), true, "a review in Hindi counts");
  });

  test("one meaningful answer in any of the three is enough", () => {
    for (const id of ["quality", "competitorComparison", "otherComments"]) {
      assert.equal(trialReviewProblem({ [id]: "Good coverage on teak" }, "approved"), null, id);
    }
  });

  test("an answer under a field that is no longer asked does not count", () => {
    assert.ok(trialReviewProblem({ drying: "Dries fast", priceFeedback: "Dearer" }, "approved"));
  });
});

/* The Negotiation gate is the existing one, unchanged: asserted here through the
   engine so the redesign cannot quietly loosen it. */
describe("the gate in front of Negotiation", () => {
  const input = (
    salesType: LeadSalesType,
    sample: LeadGateInput["sample"],
  ): LeadGateInput =>
    ({
      stage: "sample_trial",
      salesType,
      sample,
      /* Section 24's standing rule applies to every upward move: an action, a day
         and an owner. Given here so these tests ask about the SAMPLE only. */
      nextAction: "Ring about the order",
      nextActionDate: "2099-01-01",
      nextActionOwnerId: "usr_1",
    }) as unknown as LeadGateInput;

  const missing = (i: LeadGateInput) => gateTo(i, "negotiation").missing.map((m) => m.id);

  for (const type of SHOP_LADDERS) {
    test(`${type}: no sample, no Negotiation`, () => {
      assert.deepEqual(missing(input(type, undefined)), ["sample_sent"]);
    });

    test(`${type}: received but not reviewed does not open it`, () => {
      const ids = missing(input(type, { state: "received", trialOutcome: "pending", feedbackRecorded: false }));
      assert.ok(ids.includes("sample_reviewed"));
      assert.ok(ids.includes("sample_approved"));
    });

    test(`${type}: More Testing Required and Rejected do not advance the lead`, () => {
      for (const verdict of ["more_testing", "rejected"]) {
        const g = gateTo(input(type, { state: "reviewed", trialOutcome: verdict, feedbackRecorded: true }), "negotiation");
        assert.equal(g.open, false, verdict);
        assert.ok(g.missing.some((m) => m.id === "sample_approved"), verdict);
      }
    });

    test(`${type}: an Approved, recorded review opens it`, () => {
      const g = gateTo(input(type, { state: "reviewed", trialOutcome: "approved", feedbackRecorded: true }), "negotiation");
      assert.equal(g.open, true);
    });
  }
});
