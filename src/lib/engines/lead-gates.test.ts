/**
 * §28 — no lead moves forward only because somebody pressed a button.
 *
 * These are the first thing to actually exercise `lead-gates.ts`, so they are
 * written to pin the RULE rather than the code: every gate is approached from a
 * fully satisfied input with exactly one thing taken away, and the assertion is
 * that the refusal names what was taken. A test that only checks `open` is
 * false would pass just as happily on a gate that refuses everything.
 *
 * Pure: no database, no clock, no configuration except the thresholds handed
 * in — the same conditions the handset evaluates standing in a shop with no
 * signal.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { LeadStage } from "../lead-labels";
import {
  DISTRIBUTOR_CONDITIONS,
  PROSPECT_CONDITIONS,
  QUALIFICATION_CONDITIONS,
  approvalRouteReason,
  checklistFor,
  gateForNext,
  gateTo,
  ladderVerdicts,
  managementRouteReason,
  mustDecideSuspect,
  type LeadGateInput,
} from "./lead-gates";

const ALL_STAGES: readonly LeadStage[] = [
  "new",
  "contacted",
  "qualified",
  "negotiation",
  "won",
  "lost",
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
];

/** What is missing, as ids, which is what a screen groups by. */
const missingIds = (i: LeadGateInput, to: LeadStage): string[] =>
  gateTo(i, to).missing.map((c) => c.id);

/* §24 — every upward move on a real ladder owes one, so every base carries it. */
const NEXT_ACTION = {
  nextAction: "Ring the owner",
  nextActionDate: "2026-09-14",
  nextActionOwnerId: "u1",
} as const;

/* ============================================================ §5 §6 prospect */

/** A suspect with all eight §6 answers. */
function prospectReady(over: Partial<LeadGateInput> = {}): LeadGateInput {
  return {
    salesType: "direct",
    stage: "suspect",
    customerType: "Furniture workshop",
    monthlyLitres: 400,
    potentialPaise: 15_00_000,
    competitor: "Asian Paints",
    requiredProductId: "p1",
    contactPerson: "Ramesh",
    prospectReasonRecorded: true,
    ...NEXT_ACTION,
    ...over,
  };
}

describe("§6 — the eight a suspect owes before it is a prospect", () => {
  test("all eight answered opens the gate", () => {
    const v = gateTo(prospectReady(), "prospect");
    assert.deepEqual(v.missing, []);
    assert.equal(v.open, true);
  });

  test("the conditions are the eight, and 'decision maker, if known' is not one", () => {
    assert.deepEqual(PROSPECT_CONDITIONS.map((c) => c.id), [
      "customer_type",
      "monthly_litres",
      "potential_value",
      "competitor",
      "required_product",
      "contact_person",
      "next_action",
      "prospect_reason",
    ]);
    assert.equal(PROSPECT_CONDITIONS.length, 8);
  });

  /* One at a time, and the refusal has to NAME the one taken away — a refusal
     that does not say what is missing teaches a salesman to press again. */
  const KNOCKOUTS: Array<[string, Partial<LeadGateInput>]> = [
    ["customer_type", { customerType: null }],
    ["monthly_litres", { monthlyLitres: null }],
    ["potential_value", { potentialPaise: null }],
    ["competitor", { competitor: "   " }],
    ["required_product", { requiredProductId: null }],
    ["contact_person", { contactPerson: null }],
    ["next_action", { nextAction: null, nextActionDate: null, nextActionOwnerId: null }],
    ["prospect_reason", { prospectReasonRecorded: false }],
  ];

  for (const [id, gap] of KNOCKOUTS) {
    test(`refuses with ${id} missing, and says so`, () => {
      const v = gateTo(prospectReady(gap), "prospect");
      assert.equal(v.open, false);
      assert.ok(v.missing.some((c) => c.id === id), `named ${id}`);
      assert.ok(v.missing.every((c) => c.says.length > 0));
    });
  }

  test("a blank string is not an answer", () => {
    assert.ok(missingIds(prospectReady({ contactPerson: "" }), "prospect").includes("contact_person"));
    assert.ok(missingIds(prospectReady({ customerType: "  " }), "prospect").includes("customer_type"));
  });
});

/* ================================================================ §7 §9 */

describe("§7 — a prospect is verified before it is qualified", () => {
  test("the manager's verification is the gate onto qualification", () => {
    const base: LeadGateInput = { salesType: "direct", stage: "prospect", ...NEXT_ACTION };
    assert.deepEqual(missingIds(base, "qualification"), ["manager_verified"]);
    assert.equal(gateTo({ ...base, verifiedAt: "2026-09-01" }, "qualification").open, true);
  });

  test("it is asked of every ladder, distributor included", () => {
    for (const salesType of ["direct", "third_party", "distributor"] as const) {
      const v = gateTo({ salesType, stage: "prospect", ...NEXT_ACTION }, "qualification");
      assert.ok(v.missing.some((c) => c.id === "manager_verified"), salesType);
    }
  });
});

/* --------------------------------------------------------------------- §9 */

/** The eight, with the three column-backed ones actually answered. */
function trialReady(over: Partial<LeadGateInput> = {}): LeadGateInput {
  const ticks: Record<string, boolean> = {};
  for (const c of QUALIFICATION_CONDITIONS) ticks[c.id] = true;
  return {
    salesType: "direct",
    stage: "qualification",
    gstin: "27AAAPL1234C1ZV",
    /* §11.6 — the back office's answer, which is now what the gate reads. The
       salesman's old tick satisfies nothing. */
    gstVerified: true,
    monthlyLitres: 400,
    potentialPaise: 15_00_000,
    requiredProductId: "p1",
    competitor: "Asian Paints",
    creditDaysWanted: 30,
    decisionMaker: "Ramesh",
    application: "Wood finishing",
    qualification: ticks,
    ...NEXT_ACTION,
    ...over,
  };
}

describe("§5 — the eight before anybody may send a sample", () => {
  /* IT WAS TWELVE. Four were removed on the specification's own instruction:
     the monthly requirement, the potential, the product and the competitor are
     Section 4 CONVERSION fields, refused at Suspect → Prospect by
     `PROSPECT_CONDITIONS`, and asking for them again here is the re-asking the
     whole product is built to avoid. The test below asserts they are refused
     one rung UP, which is what makes removing them safe rather than a hole. */
  test("there are eight of them", () => {
    assert.equal(QUALIFICATION_CONDITIONS.length, 8);
    assert.deepEqual(QUALIFICATION_CONDITIONS.map((c) => c.id), [
      "gst_verified",
      "application_understood",
      "price_discussed",
      "credit_days",
      "delivery_discussed",
      "buyer_confirmed",
      "agrees_to_test",
      "next_step_agreed",
    ]);
  });

  test("the four Section 4 fields are not asked here", () => {
    for (const id of [
      "monthly_requirement",
      "monthly_potential",
      "required_product",
      "competitor_identified",
    ]) {
      assert.ok(
        !QUALIFICATION_CONDITIONS.some((c) => c.id === id),
        `${id} is a conversion field and must not be re-asked at qualification`,
      );
    }
  });

  test("but a lead cannot have reached here without them", () => {
    /* The half that makes the removal safe. Strip all four and ask for the
       PROSPECT move: every one of them is named. */
    const bare = gateTo(
      {
        salesType: "direct",
        stage: "suspect",
        customerType: "retailer",
        contactPerson: "Ramesh",
        prospectReasonRecorded: true,
        ...NEXT_ACTION,
      },
      "prospect",
    );
    const named = bare.missing.map((m) => m.id);
    for (const id of [
      "monthly_litres",
      "potential_value",
      "required_product",
      "competitor",
    ]) {
      assert.ok(named.includes(id), `${id} is refused one rung up: ${named.join(", ")}`);
    }
  });

  test("all eight answered opens the trial", () => {
    const v = gateTo(trialReady(), "sample_trial");
    assert.deepEqual(v.missing, []);
    assert.equal(v.open, true);
  });

  test("each of the eight, taken away one at a time, is named", () => {
    /* The tick-only ones. */
    for (const id of ["price_discussed", "delivery_discussed", "agrees_to_test", "next_step_agreed"]) {
      const ticks = { ...(trialReady().qualification as Record<string, boolean>) };
      delete ticks[id];
      assert.ok(missingIds(trialReady({ qualification: ticks }), "sample_trial").includes(id), id);
    }
    /* The column-backed ones. */
    const gaps: Array<[string, Partial<LeadGateInput>]> = [
      ["gst_verified", { gstin: null }],
      ["gst_verified", { gstVerified: false }],
      ["credit_days", { creditDaysWanted: null }],
      ["application_understood", { application: null }],
    ];
    for (const [id, gap] of gaps) {
      assert.ok(missingIds(trialReady(gap), "sample_trial").includes(id), `${id} ${JSON.stringify(gap)}`);
    }
  });

  /* §11.6 — THE VALIDATION IS SOMEBODY ELSE'S. A GST number on the record and
     the salesman's own tick used to be the whole of it, so the man who typed
     the number certified it. The column is the back office's answer and the
     old tick is deliberately not read. */
  test("a GST number the back office has not checked does not pass", () => {
    const ticks = { ...(trialReady().qualification as Record<string, boolean>) };
    ticks.gst_verified = true;
    const missing = missingIds(trialReady({ gstVerified: false, qualification: ticks }), "sample_trial");
    assert.ok(missing.includes("gst_verified"), "the salesman's tick must not stand in for the check");
  });

  /* The buyer is asked for ONLY where it is a different person, which is the
     specification's own wording and the reason this one condition can be
     satisfied by a fact about another field. */
  describe("the buyer is conditional", () => {
    test("a named buyer answers it outright", () => {
      const ticks = { ...(trialReady().qualification as Record<string, boolean>) };
      delete ticks.buyer_confirmed;
      const v = missingIds(trialReady({ buyer: "Suresh", qualification: ticks }), "sample_trial");
      assert.ok(!v.includes("buyer_confirmed"));
    });

    test("no buyer, but a decision maker confirmed as the same man, answers it", () => {
      assert.ok(
        !missingIds(trialReady({ buyer: null }), "sample_trial").includes("buyer_confirmed"),
      );
    });

    test("neither does not", () => {
      const ticks = { ...(trialReady().qualification as Record<string, boolean>) };
      delete ticks.buyer_confirmed;
      const v = missingIds(
        trialReady({ buyer: null, decisionMaker: null, qualification: ticks }),
        "sample_trial",
      );
      assert.ok(v.includes("buyer_confirmed"));
    });

    /* A lead qualified before the list was cut carries the OLD key. Reading
       only the new one would un-tick finished work and send it back down. */
    test("the old `decision_maker` tick still counts", () => {
      const v = missingIds(
        trialReady({ buyer: null, qualification: { ...(trialReady().qualification as Record<string, boolean>), buyer_confirmed: false, decision_maker: true } }),
        "sample_trial",
      );
      assert.ok(!v.includes("buyer_confirmed"));
    });
  });

  /* THE WHOLE POINT OF THE ENGINE: a tick beside an empty field is exactly the
     state it exists to stop. Every one of these is ticked below and still
     refused, because the column behind it is empty. */
  test("a tick alone does not satisfy a condition a column answers", () => {
    const ticked: Record<string, boolean> = {};
    for (const c of QUALIFICATION_CONDITIONS) ticked[c.id] = true;
    const allTicksNoValues: LeadGateInput = {
      salesType: "direct",
      stage: "qualification",
      qualification: ticked,
      ...NEXT_ACTION,
    };
    const missing = missingIds(allTicksNoValues, "sample_trial");
    for (const id of ["gst_verified", "credit_days", "application_understood"]) {
      assert.ok(missing.includes(id), `${id} refused on the tick alone`);
    }
  });

  /* GST is the one that needs BOTH: the number, and somebody saying they
     checked it. A number nobody verified is not a verified GST. */
  /* IT USED TO BE THE NUMBER AND THE SALESMAN'S TICK. It is the number and the
     BACK OFFICE'S COLUMN now — §11.6 gives validating it to them, and a tick
     the collector writes himself is not a check. Both halves are still
     required: a validated flag with no number behind it is nothing to invoice
     against. */
  test("GST needs the number AND somebody else's check", () => {
    assert.ok(missingIds(trialReady({ gstVerified: false }), "sample_trial").includes("gst_verified"));
    assert.ok(missingIds(trialReady({ gstin: null }), "sample_trial").includes("gst_verified"));
  });

  /*
   * §5.3 — the other half of cutting the checklist to eight.
   *
   * Four questions were removed from this gate because they are asked, and
   * refused, one rung up. What replaces them is not a re-ask: it is one
   * confirmation that the figures still hold, and it bites HERE, where the
   * cost is — a stale figure costs nothing while somebody is still talking to
   * the shop, and costs stock and a courier the moment a can leaves.
   */
  describe("the conversion figures have to be current", () => {
    test("stale figures refuse the sample", () => {
      const v = gateTo(trialReady({ figuresStale: true }), "sample_trial");
      assert.equal(v.open, false);
      assert.deepEqual(v.missing.map((c) => c.id), ["figures_fresh"]);
    });

    test("fresh figures pass", () => {
      assert.equal(gateTo(trialReady({ figuresStale: false }), "sample_trial").open, true);
    });

    /* Not stated and not stale are the same answer: a deployment with the
       check switched off must not have every lead refused. */
    test("saying nothing is not staleness", () => {
      assert.equal(gateTo(trialReady(), "sample_trial").open, true);
    });

    /* It refuses the SAMPLE and nothing earlier. A lead still being talked to
       is not held up by a figure from March. */
    test("it does not hold the rung below", () => {
      const v = gateTo(
        { ...trialReady({ figuresStale: true }), stage: "prospect", verifiedAt: new Date() },
        "qualification",
      );
      assert.equal(v.open, true);
    });
  });

  /*
   * §5.3 — A MANAGER WHO SAID IT WAS NOT FINISHED IS LISTENED TO. A reversal:
   * the review was recorded and changed nothing, so "this is not finished" was
   * a comment the lead walked straight past.
   */
  describe("the manager's review holds the lead", () => {
    for (const verdict of ["incomplete", "clarification"] as const) {
      test(`${verdict} refuses the sample`, () => {
        const v = gateTo(trialReady({ qualificationReview: verdict }), "sample_trial");
        assert.equal(v.open, false);
        assert.deepEqual(v.missing.map((c) => c.id), ["manager_review_open"]);
      });
    }

    test("verified passes", () => {
      assert.equal(
        gateTo(trialReady({ qualificationReview: "verified" }), "sample_trial").open,
        true,
      );
    });

    /* THE ONE THAT KEEPS IT SHIPPABLE. An unreviewed checklist passes —
       otherwise every lead in the book stops on deploy day, waiting on a
       review nobody was ever asked for. */
    test("an unreviewed checklist is not a refusal", () => {
      assert.equal(gateTo(trialReady({ qualificationReview: null }), "sample_trial").open, true);
      assert.equal(gateTo(trialReady(), "sample_trial").open, true);
    });

    test("the refusal names which of the two it was", () => {
      const inc = gateTo(trialReady({ qualificationReview: "incomplete" }), "sample_trial");
      const clr = gateTo(trialReady({ qualificationReview: "clarification" }), "sample_trial");
      assert.match(inc.missing[0].says, /incomplete/);
      assert.match(clr.missing[0].says, /clarification/);
    });
  });

  /* §23 — a sample sent to a counter nobody bills is stock nobody can account
     for. */
  test("a third-party shop with no distributor cannot be sent a sample", () => {
    const shop = trialReady({ salesType: "third_party", thirdParty: true, distributorCount: 0 });
    const v = gateTo(shop, "sample_trial");
    assert.equal(v.open, false);
    assert.deepEqual(v.missing.map((c) => c.id), ["distributor_named"]);

    const named = gateTo({ ...shop, distributorCount: 1 }, "sample_trial");
    assert.equal(named.open, true);
  });

  test("a shop we invoice ourselves is asked no such thing", () => {
    assert.equal(gateTo(trialReady({ thirdParty: false, distributorCount: 0 }), "sample_trial").open, true);
  });
});

/* ============================================================ §15 §16 §17 */

describe("the sample rungs", () => {
  const base = (over: Partial<LeadGateInput> = {}): LeadGateInput => ({
    salesType: "direct",
    stage: "sample_trial",
    ...NEXT_ACTION,
    ...over,
  });

  test("nothing reaches sample_received until it has been sent", () => {
    assert.deepEqual(missingIds(base(), "sample_received"), ["sample_dispatched"]);
    assert.equal(
      gateTo(base({ sample: { state: "dispatched", trialOutcome: "", feedbackRecorded: false } }), "sample_received").open,
      true,
    );
  });

  test("nothing reaches sample_review until they confirm they have it", () => {
    assert.deepEqual(
      missingIds(base({ sample: { state: "dispatched", trialOutcome: "", feedbackRecorded: false } }), "sample_review"),
      ["sample_delivered"],
    );
    assert.equal(
      gateTo(base({ sample: { state: "received", trialOutcome: "", feedbackRecorded: false } }), "sample_review").open,
      true,
    );
  });

  test("§17 — negotiate only once the trial is written down and approved", () => {
    const notWritten = base({
      stage: "sample_review",
      sample: { state: "reviewed", trialOutcome: "approved", feedbackRecorded: false },
    });
    assert.ok(missingIds(notWritten, "negotiation").includes("sample_reviewed"));

    const failed = base({
      stage: "sample_review",
      sample: { state: "reviewed", trialOutcome: "rejected", feedbackRecorded: true },
    });
    assert.ok(missingIds(failed, "negotiation").includes("sample_approved"));

    const good = base({
      stage: "sample_review",
      sample: { state: "reviewed", trialOutcome: "approved", feedbackRecorded: true },
    });
    assert.equal(gateTo(good, "negotiation").open, true);
  });

  /* On the legacy ladder this rung never had a gate, and it must go on not
     having one for every lead raised before the funnel existed. */
  test("a legacy lead negotiates with no gate at all", () => {
    const v = gateTo({ salesType: null, stage: "qualified" }, "negotiation");
    assert.deepEqual(v.missing, []);
    assert.equal(v.open, true);
  });
});

/* ================================================================ §18–§22 */

describe("the ledger rungs read the ledger", () => {
  const base = (over: Partial<LeadGateInput> = {}): LeadGateInput => ({
    salesType: "direct",
    stage: "negotiation",
    ...NEXT_ACTION,
    ...over,
  });

  test("§18 — a first order needs the expected date AND a real order", () => {
    assert.deepEqual(missingIds(base(), "first_order"), ["expected_order_date", "order_placed"]);
    assert.deepEqual(missingIds(base({ expectedOrderDate: "2026-09-20" }), "first_order"), ["order_placed"]);
    assert.equal(gateTo(base({ expectedOrderDate: "2026-09-20", countingOrderCount: 1 }), "first_order").open, true);
  });

  test("delivery needs a delivered order, payment needs a CONFIRMED receipt", () => {
    assert.deepEqual(missingIds(base({ stage: "first_order" }), "delivery"), ["order_delivered"]);
    assert.deepEqual(missingIds(base({ stage: "delivery" }), "payment"), ["payment_confirmed"]);
    assert.equal(gateTo(base({ deliveredOrderCount: 1 }), "delivery").open, true);
    assert.equal(gateTo(base({ confirmedPaymentCount: 1 }), "payment").open, true);
  });

  test("§21 §22 — a customer is somebody who came back", () => {
    assert.deepEqual(missingIds(base({ countingOrderCount: 1 }), "second_order"), ["second_order_placed"]);
    assert.deepEqual(missingIds(base({ countingOrderCount: 1 }), "customer"), ["two_orders"]);
    assert.equal(gateTo(base({ countingOrderCount: 2 }), "second_order").open, true);
    assert.equal(gateTo(base({ countingOrderCount: 2 }), "customer").open, true);
  });
});

/* ============================================================ §11 §12 */

/** A distributor profile with all thirty answered. */
function fullProfile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gstVerified: true,
    panVerified: true,
    businessAddressVerified: true,
    businessType: "Proprietorship",
    yearsInBusiness: 12,
    decisionMaker: "Suresh",
    hasDealerNetwork: true,
    activeDealerCount: 24,
    territoryCovered: "Vidarbha",
    citiesCovered: "Nagpur, Amravati",
    salesTeamSize: 4,
    deliveryCapability: "Two tempos",
    hasWarehouse: true,
    storageCapacityLitres: 20000,
    productPortfolio: "Paints, hardware",
    competitorBrands: "Asian, Berger",
    monthlyPotentialPaise: 50_00_000,
    initialOrderPotentialPaise: 10_00_000,
    investmentCapacityPaise: 25_00_000,
    expectedMonthlyPurchasePaise: 40_00_000,
    creditDaysRequired: 45,
    creditLimitRequiredPaise: 30_00_000,
    proposedTerritory: "Nagpur district",
    existingDistributorChecked: true,
    territoryConflict: false,
    exclusivityRequested: true,
    initialStockCommitmentPaise: 10_00_000,
    monthlyPurchaseCommitmentPaise: 40_00_000,
    dealerDevelopmentCommitment: "Ten new dealers a year",
    expectedStartDate: "2026-10-01",
    ...over,
  };
}

const distributorAt = (
  stage: LeadStage,
  over: Partial<LeadGateInput> = {},
): LeadGateInput => ({
  salesType: "distributor",
  stage,
  distributorProfile: fullProfile(),
  ...NEXT_ACTION,
  ...over,
});

describe("§11 — the thirty a distributor answers", () => {
  test("there are thirty, in five groups", () => {
    assert.equal(DISTRIBUTOR_CONDITIONS.length, 30);
    const byGroup = new Map<string, number>();
    for (const c of DISTRIBUTOR_CONDITIONS) {
      assert.ok(c.group, `${c.id} has a group`);
      byGroup.set(c.group!, (byGroup.get(c.group!) ?? 0) + 1);
    }
    assert.deepEqual([...byGroup.keys()].sort(), [
      "capability",
      "commercial",
      "commitment",
      "legal",
      "territory",
    ]);
    assert.equal([...byGroup.values()].reduce((a, b) => a + b, 0), 30);
  });

  test("a complete profile opens management review", () => {
    const v = gateTo(distributorAt("qualification"), "management_review");
    assert.deepEqual(v.missing, []);
    assert.equal(v.open, true);
  });

  test("an empty profile is refused on all thirty", () => {
    const v = gateTo(distributorAt("qualification", { distributorProfile: {} }), "management_review");
    assert.equal(v.open, false);
    assert.deepEqual(
      v.missing.map((c) => c.id).sort(),
      DISTRIBUTOR_CONDITIONS.map((c) => c.id).sort(),
    );
  });

  /* Every one of the thirty, taken away on its own. The field names differ
     from the condition ids, which is exactly the mapping worth pinning. */
  const FIELD_OF: Record<string, string> = {
    gst_verified: "gstVerified",
    pan_verified: "panVerified",
    address_verified: "businessAddressVerified",
    business_type: "businessType",
    years_in_business: "yearsInBusiness",
    decision_maker: "decisionMaker",
    dealer_network: "hasDealerNetwork",
    active_dealers: "activeDealerCount",
    territory_covered: "territoryCovered",
    cities_covered: "citiesCovered",
    sales_team: "salesTeamSize",
    delivery_capability: "deliveryCapability",
    warehouse: "hasWarehouse",
    storage_capacity: "storageCapacityLitres",
    product_portfolio: "productPortfolio",
    competitor_brands: "competitorBrands",
    monthly_potential: "monthlyPotentialPaise",
    initial_order_potential: "initialOrderPotentialPaise",
    investment_capacity: "investmentCapacityPaise",
    expected_monthly_purchase: "expectedMonthlyPurchasePaise",
    credit_days_required: "creditDaysRequired",
    credit_limit_required: "creditLimitRequiredPaise",
    proposed_territory: "proposedTerritory",
    existing_checked: "existingDistributorChecked",
    conflict_checked: "territoryConflict",
    exclusivity: "exclusivityRequested",
    initial_stock: "initialStockCommitmentPaise",
    monthly_commitment: "monthlyPurchaseCommitmentPaise",
    dealer_development: "dealerDevelopmentCommitment",
    expected_start: "expectedStartDate",
  };

  test("each of the thirty is refused on its own, and named", () => {
    for (const c of DISTRIBUTOR_CONDITIONS) {
      const field = FIELD_OF[c.id];
      assert.ok(field, `${c.id} maps to a profile column`);
      const profile = fullProfile();
      delete profile[field];
      const v = gateTo(distributorAt("qualification", { distributorProfile: profile }), "management_review");
      assert.deepEqual(v.missing.map((m) => m.id), [c.id], c.id);
    }
  });

  /* The condition is that somebody LOOKED, not that the answer was convenient.
     A real clash is management's to weigh, not the gate's to hide. */
  test("a recorded territory CONFLICT still satisfies its condition", () => {
    for (const answer of [true, false]) {
      const v = gateTo(
        distributorAt("qualification", { distributorProfile: fullProfile({ territoryConflict: answer }) }),
        "management_review",
      );
      assert.equal(v.open, true, `conflict = ${answer}`);
    }
    const unanswered = gateTo(
      distributorAt("qualification", { distributorProfile: fullProfile({ territoryConflict: null }) }),
      "management_review",
    );
    assert.deepEqual(unanswered.missing.map((c) => c.id), ["conflict_checked"]);
  });

  test("exclusivity is the same — asked and answered, either way", () => {
    for (const answer of [true, false]) {
      assert.equal(
        gateTo(
          distributorAt("qualification", { distributorProfile: fullProfile({ exclusivityRequested: answer }) }),
          "management_review",
        ).open,
        true,
        `exclusivity = ${answer}`,
      );
    }
  });

  /* These two are FACTS about the distributor, not tasks somebody completes,
     and the difference is what the gate has to respect. They were checked
     `=== true` at first, so a candidate who honestly had no godown could never
     reach `management_review` and the only way through the form was to lie on
     it — a required field that does not block bad data but manufactures it.
     The columns are nullable now, and the gate asks whether the question was
     ANSWERED. Contrast the four verification flags above, where `false` really
     does mean "not done yet" and holding out for `true` is correct. */
  test("a distributor who answers NO to the godown still passes", () => {
    for (const answer of [true, false]) {
      assert.equal(
        gateTo(
          distributorAt("qualification", { distributorProfile: fullProfile({ hasWarehouse: answer }) }),
          "management_review",
        ).open,
        true,
        `hasWarehouse = ${answer}`,
      );
      assert.equal(
        gateTo(
          distributorAt("qualification", { distributorProfile: fullProfile({ hasDealerNetwork: answer }) }),
          "management_review",
        ).open,
        true,
        `hasDealerNetwork = ${answer}`,
      );
    }
  });

  test("but an unanswered godown is still missing", () => {
    assert.deepEqual(
      gateTo(
        distributorAt("qualification", { distributorProfile: fullProfile({ hasWarehouse: null }) }),
        "management_review",
      ).missing.map((c) => c.id),
      ["warehouse"],
    );
    assert.deepEqual(
      gateTo(
        distributorAt("qualification", { distributorProfile: fullProfile({ hasDealerNetwork: null }) }),
        "management_review",
      ).missing.map((c) => c.id),
      ["dealer_network"],
    );
  });

  test("no profile at all is thirty missing, not a crash", () => {
    const v = gateTo(distributorAt("qualification", { distributorProfile: null }), "management_review");
    assert.equal(v.missing.length, 30);
  });
});

describe("§12 — the two approvals", () => {
  test("a sales manager puts them forward before terms are discussed", () => {
    assert.deepEqual(missingIds(distributorAt("management_review"), "commercial_discussion"), [
      "manager_recommended",
    ]);
    assert.equal(
      gateTo(distributorAt("management_review", { managementReviewApproved: true }), "commercial_discussion").open,
      true,
    );
  });

  test("only management appoints one, and terms come first", () => {
    assert.deepEqual(missingIds(distributorAt("commercial_discussion"), "distributor_approval"), [
      "terms_agreed",
      "management_approved",
    ]);
    assert.deepEqual(
      missingIds(distributorAt("commercial_discussion", { commercialTermsAgreed: true }), "distributor_approval"),
      ["management_approved"],
    );
    assert.equal(
      gateTo(
        distributorAt("commercial_discussion", {
          commercialTermsAgreed: true,
          distributorApprovalApproved: true,
        }),
        "distributor_approval",
      ).open,
      true,
    );
  });

  test("the agreement and the stock order are the last two rungs", () => {
    assert.deepEqual(missingIds(distributorAt("distributor_approval"), "distributor_agreement"), [
      "agreement_signed",
    ]);
    assert.deepEqual(missingIds(distributorAt("distributor_agreement"), "initial_stock_order"), [
      "stock_ordered",
    ]);
    assert.deepEqual(missingIds(distributorAt("initial_stock_order"), "active_distributor"), [
      "stock_ordered",
    ]);
    assert.equal(
      gateTo(distributorAt("initial_stock_order", { initialStockOrderPlaced: true }), "active_distributor").open,
      true,
    );
  });
});

/* ==================================================================== §24 */

describe("§24 — an active lead never sits with nothing owed by anybody", () => {
  test("an upward move on a real ladder is refused without action, date and owner", () => {
    const complete = trialReady();
    for (const gap of [
      { nextAction: null },
      { nextActionDate: null },
      { nextActionOwnerId: null },
    ]) {
      const v = gateTo({ ...complete, ...gap }, "sample_trial");
      assert.equal(v.open, false, JSON.stringify(gap));
      assert.ok(v.missing.some((c) => c.id === "next_action"));
      assert.ok(v.missing.some((c) => /what happens next/i.test(c.says)));
    }
  });

  test("it applies to every rung of every real ladder, not one stage", () => {
    const noAction = { nextAction: null, nextActionDate: null, nextActionOwnerId: null };
    const stages: Array<[LeadGateInput, LeadStage]> = [
      [{ ...trialReady(), ...noAction }, "sample_trial"],
      [{ salesType: "direct", stage: "delivery", confirmedPaymentCount: 1, ...noAction }, "payment"],
      [
        { ...distributorAt("commercial_discussion"), commercialTermsAgreed: true, distributorApprovalApproved: true, ...noAction },
        "distributor_approval",
      ],
    ];
    for (const [input, to] of stages) {
      assert.ok(missingIds(input, to).includes("next_action"), to);
    }
  });

  /* A LEGACY LEAD IS EXEMPT BY DESIGN: those leads predate the rule, and
     demanding a next action to move a four-year-old one would freeze exactly
     the book the rule was meant to unstick. */
  test("a lead with no sales type is exempt", () => {
    for (const to of ["contacted", "qualified", "negotiation", "won"] as const) {
      const v = gateTo({ salesType: null, stage: "new" }, to);
      assert.deepEqual(v.missing, [], to);
      assert.equal(v.open, true, to);
    }
  });

  test("lost never asks for one, on any ladder", () => {
    assert.equal(gateTo({ salesType: "direct", stage: "sample_trial" }, "lost").open, true);
  });
});

/* ==================================================================== §26 */

describe("§26 — lost is open from every rung", () => {
  test("from all 24 stages, on every ladder, with an empty input", () => {
    for (const salesType of ["direct", "third_party", "distributor", null] as const) {
      for (const stage of ALL_STAGES) {
        const v = gateTo({ salesType, stage }, "lost");
        assert.equal(v.open, true, `${salesType}/${stage}`);
        assert.deepEqual(v.missing, []);
      }
    }
  });

  /* The reason itself is the ACTION's business — this engine answers about
     conditions, and "say why" is a field on a form. */
  test("the engine asks for no reason of its own", () => {
    assert.deepEqual(gateTo({ salesType: "direct", stage: "prospect" }, "lost"), {
      to: "lost",
      open: true,
      missing: [],
    });
  });
});

/* ===================================================== §4 the suspect window */

describe("§4 — the suspect window pushes rather than holds", () => {
  const suspect = (over: Partial<LeadGateInput> = {}): LeadGateInput => ({
    salesType: "direct",
    stage: "suspect",
    ...over,
  });

  test("fires at the cap and not before", () => {
    assert.equal(mustDecideSuspect(suspect({ suspectVisitCount: 1 }), 2), false);
    assert.equal(mustDecideSuspect(suspect({ suspectVisitCount: 2 }), 2), true);
    assert.equal(mustDecideSuspect(suspect({ suspectVisitCount: 5 }), 2), true);
  });

  test("no visits recorded is not a demand", () => {
    assert.equal(mustDecideSuspect(suspect(), 2), false);
  });

  test("stops the moment somebody decides", () => {
    assert.equal(
      mustDecideSuspect(suspect({ suspectVisitCount: 3, suspectDecidedAt: "2026-09-01" }), 2),
      false,
    );
    assert.equal(
      mustDecideSuspect(suspect({ suspectVisitCount: 3, suspectDecidedAt: new Date() }), 2),
      false,
    );
  });

  test("it is a question about a SUSPECT and no other rung", () => {
    for (const stage of ALL_STAGES) {
      if (stage === "suspect") continue;
      assert.equal(mustDecideSuspect({ salesType: "direct", stage, suspectVisitCount: 9 }, 2), false, stage);
    }
  });

  /* Nothing is refused: both answers a salesman can give are moves this engine
     allows. Prospect is gated on §6; Not Prospect is `lost`, always open. */
  test("it refuses nothing — both answers stay reachable", () => {
    const i = suspect({ suspectVisitCount: 3 });
    assert.equal(gateTo(i, "lost").open, true);
    assert.equal(gateTo(prospectReady({ suspectVisitCount: 3 }), "prospect").open, true);
  });
});

/* ================================================== §12 the approval route */

describe("approvalRouteReason", () => {
  const T = { discountPercent: 10, creditLimitPaise: 5_00_000 };

  test("nothing out of the ordinary needs no second signature", () => {
    assert.equal(approvalRouteReason({ specialDiscountPercent: 5, agreedCreditLimitPaise: 100000 }, T), null);
    assert.equal(approvalRouteReason(null, T), null);
    assert.equal(approvalRouteReason(undefined, T), null);
    assert.equal(approvalRouteReason({}, T), null);
  });

  test("exclusivity always routes to management, whatever the figures", () => {
    assert.equal(
      approvalRouteReason({ exclusivityGranted: true, specialDiscountPercent: 0, agreedCreditLimitPaise: 0 }, T),
      "exclusivity",
    );
    /* And it wins over the other two, so the row carries the largest reason. */
    assert.equal(
      approvalRouteReason(
        { exclusivityGranted: true, specialDiscountPercent: 40, agreedCreditLimitPaise: 90_00_000 },
        T,
      ),
      "exclusivity",
    );
    /* Merely REQUESTED is not granted. */
    assert.equal(approvalRouteReason({ exclusivityRequested: true }, T), null);
  });

  test("a discount routes above the threshold and not at or below it", () => {
    assert.equal(approvalRouteReason({ specialDiscountPercent: 10.5 }, T), "over_discount");
    assert.equal(approvalRouteReason({ specialDiscountPercent: 10 }, T), null);
    assert.equal(approvalRouteReason({ specialDiscountPercent: 9.9 }, T), null);
  });

  test("a credit limit routes above the threshold and not at or below it", () => {
    assert.equal(approvalRouteReason({ agreedCreditLimitPaise: 5_00_001 }, T), "over_credit_limit");
    assert.equal(approvalRouteReason({ agreedCreditLimitPaise: 5_00_000 }, T), null);
  });

  test("a discount outranks a credit limit when both are over", () => {
    assert.equal(
      approvalRouteReason({ specialDiscountPercent: 25, agreedCreditLimitPaise: 90_00_000 }, T),
      "over_discount",
    );
  });
});

/* ------------------------------------------------------------------------- */

/*
 * THE STANDARD ROUTE, AND THE BUG IT CLOSES.
 *
 * `approvalRouteReason` used to decide whether management were asked at all,
 * and `agreeCommercialTerms` wrote a `stepIndex` 1 row only where it answered
 * something. But the gate on `distributor_approval` has always demanded
 * `distributorApprovalApproved`, so a routine candidate — no exclusivity, both
 * figures under the thresholds — had no row anybody could approve and could
 * never leave `commercial_discussion`. The checklist was complete, the terms
 * were agreed, and the refusal named a signature no screen in the product could
 * produce.
 *
 * The specification settles it: "Who acts: Management only" against both
 * `management_review` and `distributor_approval`, with "standard review" as the
 * callout's own fallback where no trigger applies. So management always review,
 * and `managementRouteReason` is what the row is written under.
 */
describe("§12 — management review every appointment, escalated or not", () => {
  const T = { discountPercent: 10, creditLimitPaise: 5_00_000 };

  test("an ordinary candidate still gets a reason to put on the row", () => {
    assert.equal(
      managementRouteReason({ specialDiscountPercent: 5, agreedCreditLimitPaise: 100000 }, T),
      "standard",
    );
    /* Including where there is no profile at all — the row is still written,
       because a missing step 1 is what stranded these candidates. */
    assert.equal(managementRouteReason(null, T), "standard");
    assert.equal(managementRouteReason(undefined, T), "standard");
    assert.equal(managementRouteReason({}, T), "standard");
  });

  test("it never answers null, which is what makes the row unconditional", () => {
    for (const profile of [
      null,
      {},
      { specialDiscountPercent: 5 },
      { exclusivityGranted: true },
      { specialDiscountPercent: 40 },
      { agreedCreditLimitPaise: 90_00_000 },
    ]) {
      assert.equal(typeof managementRouteReason(profile, T), "string");
    }
  });

  test("where something IS above a threshold it says which, not 'standard'", () => {
    assert.equal(managementRouteReason({ exclusivityGranted: true }, T), "exclusivity");
    assert.equal(managementRouteReason({ specialDiscountPercent: 25 }, T), "over_discount");
    assert.equal(managementRouteReason({ agreedCreditLimitPaise: 90_00_000 }, T), "over_credit_limit");
  });

  test("the two functions agree about everything except the ordinary case", () => {
    for (const profile of [
      { exclusivityGranted: true },
      { specialDiscountPercent: 25 },
      { agreedCreditLimitPaise: 90_00_000 },
    ]) {
      assert.equal(managementRouteReason(profile, T), approvalRouteReason(profile, T));
    }
    /* And the escalation callout still has its null to draw the ordinary
       paragraph from — the two are separate functions precisely so that one
       screen can say "nothing forced this upstairs" while the row still says
       management have it. */
    assert.equal(approvalRouteReason({ specialDiscountPercent: 5 }, T), null);
  });

  /*
   * The half that was actually broken, stated as a climb: a standard candidate
   * reaches `distributor_approval` exactly as an escalated one does, because
   * the gate never distinguished them and now nothing upstream of it does
   * either. What changed is that `distributorApprovalApproved` is now something
   * a routine appointment can become.
   */
  test("a standard candidate can reach distributor_approval", () => {
    const standardTerms = { specialDiscountPercent: 5, agreedCreditLimitPaise: 100000 };
    assert.equal(approvalRouteReason(standardTerms, T), null, "nothing escalates this one");
    assert.equal(managementRouteReason(standardTerms, T), "standard", "and it goes up anyway");

    /* Terms agreed, step 1 written under `standard`, management said yes. */
    const v = gateTo(
      distributorAt("commercial_discussion", {
        commercialTermsAgreed: true,
        distributorApprovalApproved: true,
      }),
      "distributor_approval",
    );
    assert.equal(v.open, true);
    assert.deepEqual(v.missing, []);
  });

  test("and without that signature it is still refused, which is the rule working", () => {
    assert.deepEqual(
      missingIds(
        distributorAt("commercial_discussion", { commercialTermsAgreed: true }),
        "distributor_approval",
      ),
      ["management_approved"],
    );
  });
});

/* ====================================================== the shape of it all */

describe("gateForNext and the whole climb", () => {
  test("the ordinary question is one rung up", () => {
    const v = gateForNext(trialReady());
    assert.equal(v.to, "sample_trial");
    assert.equal(v.open, true);
  });

  test("the top of a ladder says there is no next rung rather than refusing", () => {
    const v = gateForNext({ salesType: "direct", stage: "customer", ...NEXT_ACTION });
    assert.equal(v.noNextRung, true);
    assert.equal(v.open, false);
    assert.deepEqual(v.missing, []);
  });

  test("ladderVerdicts answers for every rung of this lead's own ladder", () => {
    const v = ladderVerdicts(distributorAt("qualification"));
    assert.equal(v.length, 9);
    assert.deepEqual(v.map((x) => x.to), [
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
    /* The rung it is standing on and the one above it are both answered — a
       manager reading a stalled lead wants the whole climb. */
    assert.equal(v.find((x) => x.to === "management_review")!.open, true);
    assert.equal(v.find((x) => x.to === "distributor_agreement")!.open, false);
  });

  test("checklistFor draws the same list the gate refuses on", () => {
    assert.equal(checklistFor("direct", "qualification"), QUALIFICATION_CONDITIONS);
    assert.equal(checklistFor("third_party", "qualification"), QUALIFICATION_CONDITIONS);
    assert.equal(checklistFor("distributor", "qualification"), DISTRIBUTOR_CONDITIONS);
    assert.equal(checklistFor("direct", "suspect"), PROSPECT_CONDITIONS);
    assert.deepEqual(checklistFor("direct", "delivery"), []);
  });
});

/* ============================================================== the override */

describe("a manager override is not this engine's business", () => {
  /* The override is recorded, manager-only and lives in the action. If it ever
     leaks in here, the handset would draw an open gate for a salesman who
     cannot pass it — and the refusal a manager is deliberately stepping over
     would stop being visible anywhere. */
  test("the gate still reports shut, whatever is on the input", () => {
    const shut = gateTo({ salesType: "direct", stage: "qualification" }, "sample_trial");
    assert.equal(shut.open, false);
    assert.equal("override" in shut, false);
    assert.deepEqual(Object.keys(shut).sort(), ["missing", "open", "to"]);

    /* And nothing on the input can open it but the answers themselves. */
    const withNoise = gateTo(
      { salesType: "direct", stage: "qualification", ...NEXT_ACTION, qualification: { override: true } },
      "sample_trial",
    );
    assert.equal(withNoise.open, false);
    assert.equal(withNoise.missing.length, QUALIFICATION_CONDITIONS.length);
  });
});
