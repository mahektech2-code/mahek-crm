/**
 * The three ladders, pinned rung by rung — and the one regression that matters
 * more than all of them: a lead with no sales type climbs the original six and
 * nothing else.
 *
 * That is what let seventeen enum values and three ladders ship without a
 * migration that moves a row, and it is invisible at runtime on a book where
 * nobody has set a sales type yet. So it is asserted here rather than trusted.
 *
 * Pure, like the engine: no database, no clock, no configuration beyond what is
 * handed in.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { LeadSalesType, LeadStage } from "../lead-labels";
import {
  DIRECT_LADDER,
  DISTRIBUTOR_LADDER,
  LEGACY_LADDER,
  TERMINAL_STAGES,
  THIRD_PARTY_LADDER,
  bandOf,
  directionOf,
  isOnTheBookAt,
  isParked,
  isTerminal,
  ladderFor,
  nextStage,
  previousStage,
  promotesToCustomerAt,
  rungOf,
} from "./lead-ladder";
import { gateForNext } from "./lead-gates";
import { buildQueue, type QueueCandidate } from "./queue";
import { defaultConfig } from "../config/registry";

/* ---------------------------------------------------------------------------
 * Every stage there is.
 *
 * Written out rather than derived, because the point of the exhaustiveness
 * check below is to FAIL when somebody adds a twenty-fourth: a list read off
 * the enum would grow with it silently and assert nothing.
 * ------------------------------------------------------------------------- */

const ALL_STAGES = [
  "new",
  "contacted",
  "qualified",
  "negotiation",
  "won",
  "lost",
  "on_hold",
  "suspect",
  "prospect",
  "qualification",
  "sample_trial",
  "sample_received",
  "sample_review",
  "first_order",
  "delivery",
  "payment",
  "second_order",
  "customer",
  "management_review",
  "commercial_discussion",
  "distributor_approval",
  "distributor_agreement",
  "initial_stock_order",
  "active_distributor",
] as const satisfies readonly LeadStage[];

/**
 * A compile-time half to the runtime one below: this line stops type-checking
 * the moment a stage exists that `ALL_STAGES` does not name.
 */
type Unlisted = Exclude<LeadStage, (typeof ALL_STAGES)[number]>;
const EVERY_STAGE_IS_LISTED: [Unlisted] extends [never] ? true : false = true;

/* ================================================================= ladders */

describe("the ladders", () => {
  test("every stage is accounted for", () => {
    assert.equal(EVERY_STAGE_IS_LISTED, true);
    assert.equal(ALL_STAGES.length, 24);
    assert.equal(new Set(ALL_STAGES).size, 24);
  });

  test("the legacy ladder is the six this product shipped with", () => {
    assert.deepEqual(LEGACY_LADDER, [
      "new",
      "contacted",
      "qualified",
      "negotiation",
      "won",
    ]);
  });

  test("§3A — the direct ladder, in order", () => {
    assert.deepEqual(DIRECT_LADDER, [
      "suspect",
      "prospect",
      "qualification",
      "sample_trial",
      "sample_received",
      "sample_review",
      "negotiation",
      "first_order",
      "delivery",
      "payment",
      "second_order",
      "customer",
    ]);
  });

  test("§3C — the third-party ladder is the direct one without sample_received", () => {
    assert.deepEqual(THIRD_PARTY_LADDER, [
      "suspect",
      "prospect",
      "qualification",
      "sample_trial",
      "sample_review",
      "negotiation",
      "first_order",
      "delivery",
      "payment",
      "second_order",
      "customer",
    ]);
    assert.equal(THIRD_PARTY_LADDER.includes("sample_received"), false);
    assert.deepEqual(
      DIRECT_LADDER.filter((s) => s !== "sample_received"),
      [...THIRD_PARTY_LADDER],
    );
  });

  test("§3B — the distributor ladder has no sample rungs and two approvals", () => {
    assert.deepEqual(DISTRIBUTOR_LADDER, [
      "suspect",
      "prospect",
      "qualification",
      "management_review",
      "commercial_discussion",
      "distributor_approval",
      "distributor_agreement",
      "initial_stock_order",
      "active_distributor",
    ]);
    for (const rung of ["sample_trial", "sample_received", "sample_review"] as const) {
      assert.equal(DISTRIBUTOR_LADDER.includes(rung), false, rung);
    }
    /* A sales manager may recommend one and may not appoint one — both rungs
       exist, in that order. */
    assert.ok(
      DISTRIBUTOR_LADDER.indexOf("management_review") <
        DISTRIBUTOR_LADDER.indexOf("distributor_approval"),
    );
  });

  test("ladderFor answers the right ladder for each sales type", () => {
    assert.equal(ladderFor("direct"), DIRECT_LADDER);
    assert.equal(ladderFor("third_party"), THIRD_PARTY_LADDER);
    assert.equal(ladderFor("distributor"), DISTRIBUTOR_LADDER);
  });

  /* THE REGRESSION THAT MATTERS MOST. Nothing backfills a sales type, so every
     lead in the book on the day the funnel landed is this one. */
  test("a lead with NO sales type climbs the original six and nothing else", () => {
    for (const salesType of [null, undefined] as const) {
      assert.equal(ladderFor(salesType), LEGACY_LADDER);
      const ladder = ladderFor(salesType);
      for (const stage of ALL_STAGES) {
        const isOriginal = (LEGACY_LADDER as readonly string[]).includes(stage);
        assert.equal(
          ladder.includes(stage),
          isOriginal,
          `${stage} on the legacy ladder`,
        );
      }
      assert.equal(nextStage("new", salesType), "contacted");
      assert.equal(nextStage("negotiation", salesType), "won");
      assert.equal(nextStage("won", salesType), null);
    }
  });

  test("rungOf answers -1 off the ladder", () => {
    assert.equal(rungOf("suspect", "direct"), 0);
    assert.equal(rungOf("customer", "direct"), DIRECT_LADDER.length - 1);
    assert.equal(rungOf("sample_trial", "distributor"), -1);
    assert.equal(rungOf("suspect", null), -1);
  });
});

/* ================================================================= walking */

describe("nextStage and previousStage", () => {
  test("one rung up, and null at the top", () => {
    assert.equal(nextStage("suspect", "direct"), "prospect");
    assert.equal(nextStage("sample_trial", "direct"), "sample_received");
    assert.equal(nextStage("sample_trial", "third_party"), "sample_review");
    assert.equal(nextStage("customer", "direct"), null);
    assert.equal(nextStage("active_distributor", "distributor"), null);
  });

  /* A lead whose sales type has just been changed stands on a rung that is not
     on its new ladder. Answering null there would leave the record with no
     button at all and nothing saying why. */
  test("off the ladder answers the FOOT of the new ladder, never null", () => {
    assert.equal(nextStage("sample_received", "distributor"), "suspect");
    assert.equal(nextStage("management_review", "direct"), "suspect");
    assert.equal(nextStage("suspect", null), "new");
    assert.equal(nextStage("lost", "direct"), "suspect");
  });

  test("one rung down, and null at the foot or off the ladder", () => {
    assert.equal(previousStage("prospect", "direct"), "suspect");
    assert.equal(previousStage("suspect", "direct"), null);
    assert.equal(previousStage("sample_received", "distributor"), null);
  });
});

describe("directionOf", () => {
  test("up, down, same", () => {
    assert.equal(directionOf("suspect", "prospect", "direct"), "up");
    assert.equal(directionOf("payment", "delivery", "direct"), "down");
    assert.equal(directionOf("payment", "payment", "direct"), "same");
  });

  test("§26 — lost is OUT from anywhere, never a step down", () => {
    for (const stage of ALL_STAGES) {
      if (stage === "lost") {
        assert.equal(directionOf(stage, "lost", "direct"), "same");
        continue;
      }
      assert.equal(directionOf(stage, "lost", "direct"), "out", stage);
      assert.equal(directionOf(stage, "lost", null), "out", stage);
    }
  });

  test("a rung on neither ladder is off_ladder rather than a guess", () => {
    assert.equal(directionOf("sample_trial", "prospect", "distributor"), "off_ladder");
    assert.equal(directionOf("new", "qualification", null), "off_ladder");
  });
});

describe("isTerminal", () => {
  test("the four ends, and only those", () => {
    assert.deepEqual(TERMINAL_STAGES, ["won", "lost", "customer", "active_distributor"]);
    for (const stage of ALL_STAGES) {
      const expected = (TERMINAL_STAGES as readonly string[]).includes(stage);
      assert.equal(isTerminal(stage), expected, stage);
    }
  });
});

/* =================================================================== bands */

/**
 * Every stage, and the band the funnel counts it in.
 *
 * Exhaustive on purpose: the failure this guards against is a new rung falling
 * through `bandOf`'s default and quietly leaving the funnel — a pipeline that
 * shrinks as the team works it, with nothing on any screen saying why.
 */
const EXPECTED_BAND: Record<LeadStage, "new" | "contacted" | "qualified" | "negotiation" | null> = {
  /* Parked, and null for a DIFFERENT reason than the four below it: a lead on
     hold has not left the funnel, its rung is simply not recoverable from the
     stage. `isParked` is how a screen counts them instead of losing them. */
  on_hold: null,
  new: "new",
  suspect: "new",

  contacted: "contacted",
  prospect: "contacted",

  qualified: "qualified",
  qualification: "qualified",
  sample_trial: "qualified",
  sample_received: "qualified",
  sample_review: "qualified",
  management_review: "qualified",

  negotiation: "negotiation",
  commercial_discussion: "negotiation",
  distributor_approval: "negotiation",
  distributor_agreement: "negotiation",
  first_order: "negotiation",
  delivery: "negotiation",
  payment: "negotiation",
  second_order: "negotiation",
  initial_stock_order: "negotiation",

  /* Out of the funnel by design — a funnel counts what is still in it. */
  won: null,
  lost: null,
  customer: null,
  active_distributor: null,
};

describe("bandOf", () => {
  test("every one of the 24 stages lands where it is meant to", () => {
    for (const stage of ALL_STAGES) {
      assert.equal(bandOf(stage), EXPECTED_BAND[stage], stage);
    }
  });

  test("nothing falls through the default unintentionally", () => {
    /* Only the four closed rungs and the parked one answer null. Any OTHER
       stage that answers null is either deliberately out of the funnel — in
       which case it belongs in this list — or it is the bug this test exists
       for: a rung that quietly leaves the pipeline as the team works it.

       `on_hold` is in the list for a different reason than the four beside it,
       and the difference is the thing to remember: those have left the funnel,
       and a parked lead has not. Its rung is simply not recoverable from the
       stage column, so `bandOf` refuses rather than guessing, and a screen
       counts it with `isParked` instead of losing it. */
    const outOfFunnel = ALL_STAGES.filter((s) => bandOf(s) === null);
    assert.deepEqual([...outOfFunnel].sort(), [
      "active_distributor",
      "customer",
      "lost",
      "on_hold",
      "won",
    ]);
    assert.equal(outOfFunnel.filter((s) => !isParked(s)).length, 4);
  });

  test("the original six band as themselves, so no KPI moved", () => {
    assert.equal(bandOf("new"), "new");
    assert.equal(bandOf("contacted"), "contacted");
    assert.equal(bandOf("qualified"), "qualified");
    assert.equal(bandOf("negotiation"), "negotiation");
    assert.equal(bandOf("won"), null);
    assert.equal(bandOf("lost"), null);
  });
});

/* ============================================================== on the book */

describe("promotesToCustomerAt", () => {
  /* THE SECOND ORDER, and the reason is the trade rather than the schema: a
     first order from a shop that has just finished a trial is a few cans to see
     how it behaves in their own booth. It is not a relationship and it
     routinely does not repeat. The second order is the one that says the trial
     worked. */
  test("the second order, except a distributor, who is appointed", () => {
    assert.equal(promotesToCustomerAt("direct"), "second_order");
    assert.equal(promotesToCustomerAt("third_party"), "second_order");
    assert.equal(promotesToCustomerAt(null), "second_order");
    assert.equal(promotesToCustomerAt("distributor"), "distributor_approval");
  });
});

describe("isParked", () => {
  test("on_hold only, and it is not terminal", () => {
    assert.equal(isParked("on_hold"), true);
    assert.equal(isTerminal("on_hold"), false);
    for (const s of ["suspect", "negotiation", "lost", "won", "customer"] as const) {
      assert.equal(isParked(s), false, s);
    }
  });

  /* The bug this exists to stop: `on_hold` is on no ladder, so `nextStage`
     answered with the FOOT of one and parking a qualified lead offered to move
     it back to Suspect. */
  test("a parked lead is offered no next rung at all", () => {
    const v = gateForNext({ salesType: "direct", stage: "on_hold" });
    assert.equal(v.noNextRung, true);
    assert.equal(v.open, false);
  });
});

describe("isOnTheBookAt", () => {
  test("at the promoting rung, and every rung above it", () => {
    assert.equal(isOnTheBookAt("second_order", "direct"), true);
    assert.equal(isOnTheBookAt("customer", "direct"), true);
  });

  /* A shop with ONE order is still a lead, which is the whole point of the
     rule and the thing most likely to be "corrected" back by somebody who
     assumes an account that has ordered must be a customer. */
  test("not below it — one order does not make a customer", () => {
    for (const stage of [
      "suspect", "prospect", "qualification", "sample_trial",
      "negotiation", "first_order", "delivery", "payment",
    ] as const) {
      assert.equal(isOnTheBookAt(stage, "direct"), false, stage);
    }
  });

  /* A manager clearing a backlog moves a lead straight from qualification to
     payment. It has plainly ordered; asking only about the exact rung would
     leave it a lead. */
  test("a lead moved straight past the promoting rung is still on the book", () => {
    assert.equal(isOnTheBookAt("customer", "direct"), true);
    assert.equal(isOnTheBookAt("distributor_agreement", "distributor"), true);
  });

  test("a distributor joins the book when it is appointed, not before", () => {
    assert.equal(isOnTheBookAt("commercial_discussion", "distributor"), false);
    assert.equal(isOnTheBookAt("distributor_approval", "distributor"), true);
    assert.equal(isOnTheBookAt("initial_stock_order", "distributor"), true);
  });

  test("lost is never on the book, from any rung or any ladder", () => {
    for (const salesType of ["direct", "third_party", "distributor", null] as const) {
      assert.equal(isOnTheBookAt("lost", salesType), false, String(salesType));
    }
  });

  test("the closed ends are on the book", () => {
    assert.equal(isOnTheBookAt("won", null), true);
    assert.equal(isOnTheBookAt("customer", "direct"), true);
    assert.equal(isOnTheBookAt("active_distributor", "distributor"), true);
  });

  test("a rung off this lead's own ladder answers no rather than guessing", () => {
    assert.equal(isOnTheBookAt("first_order", "distributor"), false);
    assert.equal(isOnTheBookAt("payment", null), false);
  });
});

/* =========================================== the Call Log's half of it */

/**
 * THE SAFETY HALF: the office must not cold-call a shop the field team is
 * standing in.
 *
 * A funnel lead stays `kind = 'lead'` through eleven rungs, and a lead with no
 * order is a prospect to the calling queue — so without this the Call Log rings
 * it every few days for months, asking for the first order a salesman is in the
 * middle of asking for himself.
 *
 * And it is HELD BACK, not dropped: suppression is a return value here, so the
 * telecaller sees who is missing and why.
 */
const C = defaultConfig();
const TODAY = "2026-08-03";

function candidate(over: Partial<QueueCandidate> = {}): QueueCandidate {
  return {
    customerId: "c1",
    name: "Test Shop",
    ownerId: "u1",
    lastOrderDate: null,
    cycleDays: 30,
    cycleIsDefault: false,
    cycleConfidence: 50,
    typicalOrderPaise: 0,
    lastContactDate: null,
    createdDate: "2025-01-01",
    reminders: [],
    lastConfirmedWhatsappDate: null,
    activeInOrderSystem: false,
    thirdParty: false,
    leadSalesType: null,
    calledToday: false,
    doNotContact: false,
    skippedTodayReason: null,
    lastAnsweredOutcome: null,
    lastAnsweredDate: null,
    noAnswerCount: 0,
    lastNoAnswerAt: null,
    openOrderStatus: null,
    paymentCallDue: null,
    outstanding: 0,
    targetGap: 0,
    ...over,
  };
}

describe("the Call Log and a lead on the funnel", () => {
  test("a lead with no sales type is still a prospect, exactly as before", () => {
    const r = buildQueue([candidate()], TODAY, C);
    assert.equal(r.entries.length, 1);
    assert.ok(r.entries[0].reasons.some((x) => x.kind === "prospect"));
    assert.equal(r.suppressed.length, 0);
  });

  test("a lead the field team is working is held back, not chased", () => {
    for (const salesType of ["direct", "distributor", "third_party"] as const) {
      const r = buildQueue([candidate({ leadSalesType: salesType })], TODAY, C);
      assert.equal(r.entries.length, 0, salesType);
      assert.equal(r.suppressed.length, 1, salesType);
    }
  });

  test("and the strip says why, in words", () => {
    const r = buildQueue([candidate({ leadSalesType: "direct" })], TODAY, C);
    const held = r.suppressed[0];
    assert.equal(held.customerId, "c1");
    assert.match(held.reason, /funnel/i);
    assert.match(held.reason, /first order/i);
  });

  /* Only the prospect reason goes. A promise somebody made and money this
     account owes are not the first order the salesman is out asking for. */
  test("a promised callback still reaches the telecaller", () => {
    const r = buildQueue(
      [
        candidate({
          leadSalesType: "direct",
          reminders: [
            {
              id: "r1",
              dueDate: TODAY,
              note: "Ring back about the sample",
              holdOtherReasonsUntilDue: false,
            },
          ],
        }),
      ],
      TODAY,
      C,
    );
    assert.equal(r.entries.length, 1);
    assert.equal(r.suppressed.length, 0);
    assert.ok(r.entries[0].reasons.some((x) => x.kind === "reminderDueToday"));
    assert.equal(r.entries[0].reasons.some((x) => x.kind === "prospect"), false);
  });

  test("a marked third-party shop behaves as it always did", () => {
    const r = buildQueue([candidate({ thirdParty: true })], TODAY, C);
    assert.equal(r.entries.length, 0);
  });
});

/* Keeps the sales-type union honest against the ladder switch. */
const _everySalesTypeHasALadder: Record<LeadSalesType, readonly LeadStage[]> = {
  direct: DIRECT_LADDER,
  distributor: DISTRIBUTOR_LADDER,
  third_party: THIRD_PARTY_LADDER,
};
void _everySalesTypeHasALadder;
