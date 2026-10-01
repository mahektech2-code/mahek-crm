import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  gstinChangeClear,
  materialChanges,
  materialOf,
  reviewVoidPatch,
  sameAnswer,
  MATERIAL_COLUMNS,
  type ReviewVoidLead,
} from "./lead-review-void";
import { qualificationAccess } from "./lead-qualification-access";

/* ---------------------------------------------------------------------------
 * When a manager's "verified" stops being true — the rule, and the guard that
 * keeps a new writer from going round it.
 * ------------------------------------------------------------------------- */

const verified = (over: Partial<ReviewVoidLead> = {}): ReviewVoidLead => ({
  leadStage: "qualification",
  leadQualificationReview: "verified",
  gstin: "27ABCDE1234F1Z5",
  gstVerified: true,
  leadApplication: "Wood polish",
  leadCreditDaysWanted: 30,
  leadBuyer: "Brother",
  leadDecisionMaker: "Owner",
  leadMonthlyVolumeLitres: 300,
  leadEstimatedPotentialPaise: 9_000_000,
  leadRequiredProductId: "p1",
  leadCompetitor: "Local",
  leadSalesType: "direct",
  leadQualification: { price_discussed: true, delivery_discussed: true, agrees_to_test: true, next_step_agreed: true },
  ...over,
});

describe("what counts as a material change", () => {
  const changes: Array<[string, Record<string, unknown>]> = [
    ["GSTIN", { gstin: "29AAAAA0000A1Z5" }],
    ["GST verification state", { gstVerified: false }],
    ["application", { leadApplication: "Furniture" }],
    ["credit days", { leadCreditDaysWanted: 45 }],
    ["buyer", { leadBuyer: "Accountant" }],
    ["decision maker", { leadDecisionMaker: "Son" }],
    ["monthly litres", { leadMonthlyVolumeLitres: 900 }],
    ["potential", { leadEstimatedPotentialPaise: 1 }],
    ["product", { leadRequiredProductId: "p2" }],
    ["competitor", { leadCompetitor: "Asian" }],
    ["sales type", { leadSalesType: "third_party" }],
    ["a tick taken away", { leadQualification: { price_discussed: false, delivery_discussed: true, agrees_to_test: true, next_step_agreed: true } }],
  ];
  for (const [name, change] of changes) {
    test(`${name} voids a verified review`, () => {
      const v = reviewVoidPatch(verified(), change);
      assert.ok(v, name);
      assert.deepEqual(v!.set, {
        leadQualificationReview: null,
        leadQualificationReviewNote: null,
        leadQualificationReviewedAt: null,
        leadQualificationReviewedById: null,
      });
      assert.ok(v!.fields.length >= 1);
    });
  }

  test("a distributor link voids it too (it is not a customers column)", () => {
    assert.ok(reviewVoidPatch(verified(), {}, { extra: ["distributor"] }));
  });

  test("an identical re-save changes nothing — blank, null, whitespace and equal numbers are one state", () => {
    assert.equal(reviewVoidPatch(verified(), { leadApplication: "Wood polish", leadCreditDaysWanted: 30, gstin: "27ABCDE1234F1Z5" }), null);
    assert.equal(reviewVoidPatch(verified(), { leadApplication: "  Wood polish " }), null);
    assert.equal(reviewVoidPatch(verified({ leadBuyer: null }), { leadBuyer: "" }), null);
    assert.equal(reviewVoidPatch(verified(), { leadCreditDaysWanted: "30" }), null);
    assert.equal(sameAnswer(undefined, null), true);
  });

  test("ticks the gate does not read are not material", () => {
    const same = { ...verified().leadQualification, gst_verified: true, some_old_key: "x" };
    assert.equal(reviewVoidPatch(verified(), { leadQualification: same }), null);
  });

  test("nothing else is material: the next action, notes and contact details are not even offered", () => {
    const stray = { leadNextAction: "x", leadNotes: "y", contactPerson: "z" } as Record<string, unknown>;
    assert.deepEqual(materialOf(stray), {});
    assert.equal(reviewVoidPatch(verified(), materialOf(stray)), null);
  });

  test("a standing review can be voided — verified or a note sent back — but no review cannot, and only at Qualification", () => {
    assert.equal(reviewVoidPatch(verified({ leadQualificationReview: null }), { leadApplication: "x" }), null);
    for (const review of ["verified", "incomplete", "clarification"]) {
      assert.ok(reviewVoidPatch(verified({ leadQualificationReview: review }), { leadApplication: "x" }), review);
      /* …and an unchanged value voids none of them: the note stays until something changes. */
      assert.equal(reviewVoidPatch(verified({ leadQualificationReview: review }), { leadApplication: "Wood polish" }), null, review);
    }
    for (const stage of ["prospect", "sample_trial", "customer"]) {
      assert.equal(reviewVoidPatch(verified({ leadStage: stage }), { leadApplication: "x" }), null, stage);
    }
  });

  test("the reviewer's own edit does not void his review — except a change of sales type", () => {
    assert.equal(reviewVoidPatch(verified(), { leadApplication: "x", gstin: "29AAAAA0000A1Z5" }, { reviewer: true }), null);
    assert.equal(reviewVoidPatch(verified(), {}, { reviewer: true, extra: ["distributor"] }), null);
    const structural = reviewVoidPatch(verified(), { leadSalesType: "third_party", leadApplication: "x" }, { reviewer: true });
    assert.ok(structural);
    assert.deepEqual(structural!.fields, ["sales type"]);
  });

  test("every column in the rule is one the tests above exercise", () => {
    const named = new Set(changes.flatMap(([, c]) => Object.keys(c)).concat("leadQualification"));
    for (const column of MATERIAL_COLUMNS) assert.ok(named.has(column), `${column} has no case above`);
    assert.deepEqual(materialChanges(verified(), {}), []);
  });
});

describe("a changed GSTIN is not the validated one", () => {
  test("changing it clears the validation; saving the same number, or a number with none to clear, does not", () => {
    assert.deepEqual(gstinChangeClear({ gstin: "A", gstVerified: true }, "B"), {
      gstVerified: false,
      gstVerifiedAt: null,
      gstVerifiedById: null,
    });
    assert.equal(gstinChangeClear({ gstin: "A", gstVerified: true }, "A"), null);
    assert.equal(gstinChangeClear({ gstin: "A", gstVerified: true }, " A "), null);
    assert.equal(gstinChangeClear({ gstin: "A", gstVerified: false }, "B"), null);
    assert.deepEqual(gstinChangeClear({ gstin: "A", gstVerified: true }, null)?.gstVerified, false);
  });
});

describe("Qualification is written at Qualification", () => {
  test("only Qualification and its legacy twin are writable, and the rest say why", () => {
    assert.equal(qualificationAccess("qualification").writable, true);
    assert.equal(qualificationAccess("qualified").writable, true);
    for (const stage of ["prospect", "contacted", "suspect", "new", null, "sample_trial", "customer"]) {
      const a = qualificationAccess(stage);
      assert.equal(a.writable, false, String(stage));
      assert.ok(a.reason && a.reason.length > 10, String(stage));
    }
    assert.match(qualificationAccess("prospect").reason ?? "", /Sales Manager/);
  });
});

/* ------------------------------------------------------------------------- */

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/**
 * THE GUARD. A file that UPDATEs `customers` and sets one of the material
 * columns must go through the rule that voids a manager's review, or the
 * approval survives an edit its reviewer never saw.
 *
 * The allowlist is the list of writers that have a reason not to, each with the
 * reason — and the reasons are all the same shape: the write happens where no
 * review can exist yet (a lead being created, a Suspect still on the Calling
 * Desk), or it is a projection from a sheet that fills blanks only and never
 * corrects a person. A NEW writer is not on the list, so it fails here until
 * somebody either routes it through `reviewVoidPatch` or writes down why not.
 */
const NOT_A_REVIEW_WRITER: Record<string, string> = {
  "src/lib/actions/lead-calling-desk.ts":
    "the Calling Desk's own answers, written before a lead is a Prospect — no review exists to void",
  "src/lib/actions/lead-distributor-migration.ts":
    "moves a lead off the DISTRIBUTOR ladder onto a shop ladder — that ladder has no qualification review, so there is none to void",
  "src/lib/services/lead-service.ts":
    "the stage move: it inserts the transition row and moves the rung, and never edits an answer a review depends on",
  "src/lib/actions/lead-intake.ts":
    "a lead being created, or a bulk file of new ones — nothing has been reviewed",
  "src/lib/services/customer-master-projection-service.ts":
    "sets the sales type only when INSERTING a shop it has never seen; its one update enriches contact details on an existing account and never touches an answer a review reads",
};

describe("no writer of a material column can go round the rule", () => {
  const MATERIAL =
    /\b(leadApplication|leadCreditDaysWanted|leadBuyer|leadDecisionMaker|leadCompetitor|leadRequiredProductId|leadMonthlyVolumeLitres|leadEstimatedPotentialPaise|leadSalesType|gstVerified):[ \t]*(?![ \t]*(?:customers\.|lead\.|row\.|record\.|true\b))/;
  const UPDATES = /\.update\(customers\)/;

  test("every file that updates customers and sets one goes through reviewVoidPatch", () => {
    const offenders: string[] = [];
    for (const file of walk("src/lib")) {
      const rel = file.replace(/\\/g, "/");
      if (NOT_A_REVIEW_WRITER[rel]) continue;
      const src = readFileSync(file, "utf8");
      if (!UPDATES.test(src) || !MATERIAL.test(src)) continue;
      if (/reviewVoidPatch|voidReviewForDistributorChange/.test(src)) continue;
      offenders.push(rel);
    }
    assert.deepEqual(
      offenders,
      [],
      "These files write a column a manager's review depends on without voiding it. " +
        "Route the write through `reviewVoidPatch` (and `recordReviewVoid`), or add the file to " +
        "NOT_A_REVIEW_WRITER with the reason no review can exist there.\n  " +
        offenders.join("\n  "),
    );
  });

  test("the allowlist names files that exist", () => {
    for (const rel of Object.keys(NOT_A_REVIEW_WRITER)) assert.ok(statSync(rel).isFile(), rel);
  });
});
