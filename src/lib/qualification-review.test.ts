import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DESK_FIELDS } from "@/lib/engines/lead-calling-desk";
import {
  PROSPECT_CONDITIONS,
  QUALIFICATION_ANSWER_KEYS,
  QUALIFICATION_CONDITIONS,
  type LeadGateInput,
} from "@/lib/engines/lead-gates";
import {
  auditValue,
  buildReviewRows,
  confirmBlockers,
  diffAnswers,
  isCollectorEdit,
  maskGstin,
  QUALIFICATION_FIELDS,
  reviewTally,
  splitEdits,
  type ReviewSource,
} from "@/lib/qualification-review";

const NONE = new Set<string>();
const ALL_PROSPECT = new Set(PROSPECT_CONDITIONS.map((c) => c.id));
const ALL_QUAL = new Set(QUALIFICATION_CONDITIONS.map((c) => c.id));

/* THE REPEATS: Prospect questions that are a Suspect question asked again, and
   Qualification questions whose only answer is already a Suspect row. Each is
   the same stored answer, so the review draws it once, on the Suspect row. */
const PROSPECT_REPEATS = ["customer_type", "monthly_litres", "competitor", "required_product", "gstin"];
const QUALIFICATION_REPEATS = ["gst_verified", "application_understood"];
const PROSPECT_ONLY = PROSPECT_CONDITIONS.filter((c) => !PROSPECT_REPEATS.includes(c.id));
const QUALIFICATION_ONLY = QUALIFICATION_CONDITIONS.filter((c) => !QUALIFICATION_REPEATS.includes(c.id));

const EMPTY: ReviewSource = {
  salesType: "direct",
  customerType: null,
  decisionMaker: null,
  buyer: null,
  gstin: null,
  gstVerified: false,
  monthlyLitres: null,
  creditDaysWanted: null,
  requiredProductId: null,
  requiredProductName: null,
  competitor: null,
  application: null,
  contactPerson: null,
  address: null,
  email: null,
  nextAction: null,
  nextActionDate: null,
  prospectReason: null,
  qualification: null,
  unmetProspect: ALL_PROSPECT,
  unmetQualification: ALL_QUAL,
};

const FULL: ReviewSource = {
  ...EMPTY,
  customerType: "retailer",
  decisionMaker: "Owner",
  buyer: "Ganesh's brother",
  gstin: "27ABCDE1234F1Z5",
  gstVerified: true,
  monthlyLitres: 300,
  creditDaysWanted: 30,
  requiredProductId: "prd_1",
  requiredProductName: "PU Thinner - 20 Liter (Loose)",
  competitor: "Local thinner",
  application: "Wood polish",
  contactPerson: "Ganesh",
  nextAction: "Review qualification",
  nextActionDate: "2026-09-29",
  prospectReason: "High monthly consumption or potential",
  qualification: { trial_product: "PU Thinner", price_range: "₹180–200 / L", price_reaction: "negotiating", delivery_suits: "yes", willing_to_test: "yes" },
  unmetProspect: NONE,
  unmetQualification: NONE,
};

const APPROVER = { editable: true, collectorOnlyReason: null };
const READER = { editable: false, collectorOnlyReason: null };
const SALES_MANAGER = {
  editable: true,
  collectorOnlyReason:
    "The Salesman who owns this lead completes its Qualification, and you review it. If nobody owns it yet, name a Salesman as its owner first.",
};

const fieldOf = (rows: ReturnType<typeof buildReviewRows>, rowKey: string, id: string) =>
  rows.find((r) => r.key === rowKey)!.fields.find((f) => f.id === id)!;

describe("every CURRENT question is on the review", () => {
  const rows = buildReviewRows(EMPTY, READER);
  test("all the Calling Desk's fields, in the desk's order", () => {
    assert.deepEqual(rows.filter((r) => r.section === "suspect").map((r) => r.id), DESK_FIELDS.map((f) => f.key));
  });
  test("the Prospect questions the Suspect list did not already ask", () => {
    assert.deepEqual(rows.filter((r) => r.section === "prospect").map((r) => r.id), PROSPECT_ONLY.map((c) => c.id));
    assert.deepEqual(PROSPECT_ONLY.map((c) => c.id), ["contact_person", "next_action", "prospect_reason"]);
  });
  test("the Qualification questions that add something the review has not already drawn", () => {
    assert.deepEqual(rows.filter((r) => r.section === "qualification").map((r) => r.id), QUALIFICATION_ONLY.map((c) => c.id));
  });
  test("the whole review is 20 unique rows, the Prospect-stage one 14", () => {
    assert.equal(rows.length, 20);
    assert.equal(buildReviewRows(EMPTY, { ...READER, kind: "prospect" }).length, 14);
  });
  test("the counts are the current ones: 11, 8 (GST number added) and 8", () => {
    assert.equal(DESK_FIELDS.length, 11);
    assert.equal(PROSPECT_CONDITIONS.length, 8);
    assert.equal(QUALIFICATION_CONDITIONS.length, 8);
  });
  test("the two optional Prospect questions are drawn, but are not 'required'", () => {
    const rows = buildReviewRows(EMPTY, READER);
    for (const id of ["contact_person", "prospect_reason"]) assert.equal(rows.find((r) => r.key === `prospect:${id}`)!.required, false, id);
    assert.equal(rows.find((r) => r.key === "prospect:next_action")!.required, true);
    /* The repeated ones are required where they are drawn now: on the Suspect row. */
    for (const k of ["customerType", "monthlyLitres", "competitor", "requiredProductId", "gstin"]) {
      assert.equal(rows.find((r) => r.key === `suspect:${k}`)!.required, true, k);
    }
  });
  test("a repeated question is drawn once: the Prospect and Qualification copies are gone", () => {
    const r = buildReviewRows(FULL, APPROVER);
    for (const id of PROSPECT_REPEATS) assert.equal(r.some((x) => x.key === `prospect:${id}`), false, id);
    for (const id of QUALIFICATION_REPEATS) assert.equal(r.some((x) => x.key === `qualification:${id}`), false, id);
    /* …and its answer is still on the Suspect row, unchanged. */
    assert.equal(fieldOf(r, "suspect:gstin", "gstin").value, "27ABCDE1234F1Z5");
    assert.equal(fieldOf(r, "suspect:application", "application").value, "Wood polish");
  });
  test("no stored answer has two boxes anywhere on the review", () => {
    const ids = buildReviewRows(FULL, APPROVER).flatMap((r) => r.fields.map((f) => f.id));
    assert.equal(new Set(ids).size, ids.length, `a box is drawn twice: ${ids.join(", ")}`);
    assert.ok(buildReviewRows(FULL, APPROVER).flatMap((r) => r.fields).every((f) => !f.sameAs));
  });
  test("Qualification keeps only the part of a shared question that nothing above asked", () => {
    const r = buildReviewRows(FULL, APPROVER);
    const boxes = (key: string) => r.find((x) => x.key === key)!.fields.map((f) => f.id);
    assert.deepEqual(boxes("qualification:people_identified"), ["decision_maker_phone", "buyer_same", "buyer_phone", "payer", "payer_same", "payer_phone"]);
    assert.deepEqual(boxes("qualification:price_and_credit"), ["price_range", "price_reaction"]);
  });
  test("before Qualification opens its questions are not built, and the Prospect review is 14 rows", () => {
    const r = buildReviewRows(FULL, { ...APPROVER, kind: "prospect" });
    assert.equal(r.some((x) => x.section === "qualification"), false);
    assert.equal(r.length, 14);
  });
  test("a duplicate's gate verdict is kept on the one row: GST not yet validated reads as unanswered at Qualification only", () => {
    const pending = { ...FULL, unmetQualification: new Set(["gst_verified"]) };
    assert.equal(buildReviewRows(pending, APPROVER).find((x) => x.key === "suspect:gstin")!.answered, false);
    assert.equal(buildReviewRows(pending, { ...APPROVER, kind: "prospect" }).find((x) => x.key === "suspect:gstin")!.answered, true);
    const unmetApplication = { ...FULL, unmetQualification: new Set(["application_understood"]) };
    assert.equal(buildReviewRows(unmetApplication, APPROVER).find((x) => x.key === "suspect:application")!.answered, false);
  });
  test("an unmet Prospect gate condition shows on the Suspect row that now carries it", () => {
    const r = buildReviewRows({ ...FULL, unmetProspect: new Set(["monthly_litres"]) }, APPROVER);
    assert.equal(r.find((x) => x.key === "suspect:monthlyLitres")!.answered, false);
  });
  test("labels are the existing definitions, not a second wording", () => {
    for (const f of DESK_FIELDS) assert.equal(rows.find((r) => r.key === `suspect:${f.key}`)?.label, f.label);
    for (const c of PROSPECT_ONLY) assert.equal(rows.find((r) => r.key === `prospect:${c.id}`)?.label, c.says);
    for (const c of QUALIFICATION_ONLY) assert.equal(rows.find((r) => r.key === `qualification:${c.id}`)?.label, c.says);
  });
  test("every Qualification answer key the gate stores has a box", () => {
    const boxed = new Set(Object.values(QUALIFICATION_FIELDS).flat().map((s) => s.id));
    /* `buyer_name` is the handset's alternative to the `lead_buyer` column; the
       Qualify screen draws no box for it either, and the review shows it as the
       buyer's value. */
    for (const k of QUALIFICATION_ANSWER_KEYS.filter((k) => k !== "buyer_name")) assert.ok(boxed.has(k), `no box for ${k}`);
  });
  test("the boxes' labels and keys are the Qualify screen's own (drift guard)", () => {
    const screen = readFileSync("src/components/leads/record/qualify/qualify-screen.tsx", "utf8");
    for (const s of Object.values(QUALIFICATION_FIELDS).flat()) {
      if (s.label) assert.ok(screen.includes(`label: "${s.label}"`), `label drifted: ${s.label}`);
      assert.ok(screen.includes(`key: "${s.id}"`), `key drifted: ${s.id}`);
    }
  });
});

describe("saved answers are loaded and read as a person reads them", () => {
  const rows = buildReviewRows(FULL, APPROVER);
  test("figures carry their unit", () => {
    assert.equal(fieldOf(rows, "suspect:monthlyLitres", "monthlyLitres").display, "300 Litres");
    assert.equal(fieldOf(rows, "suspect:creditDaysWanted", "creditDaysWanted").display, "30 days");
    assert.equal(fieldOf(rows, "suspect:requiredProductId", "requiredProductId").display, "PU Thinner - 20 Liter (Loose)");
  });
  test("the GST number says whether it was checked", () => {
    assert.match(fieldOf(rows, "suspect:gstin", "gstin").display, /27ABCDE1234F1Z5 \(Verified\)/);
  });
  test("composite Qualification answers are read part by part", () => {
    assert.equal(fieldOf(rows, "qualification:trial_plan", "trial_product").value, "PU Thinner");
    assert.equal(fieldOf(rows, "qualification:price_and_credit", "price_reaction").display, "Negotiating");
    assert.equal(fieldOf(rows, "qualification:delivery_workable", "delivery_suits").display, "Yes");
  });
  test("the prospect reason and next action are shown", () => {
    assert.equal(fieldOf(rows, "prospect:prospect_reason", "prospect_reason").display, "High monthly consumption or potential");
    assert.match(fieldOf(rows, "prospect:next_action", "next_action").display, /Review qualification — 2026-09-29/);
  });
});

describe("answered is the GATE's verdict, and missing answers are flagged", () => {
  test("a lead the gate calls complete has nothing required missing", () => {
    assert.equal(reviewTally(buildReviewRows(FULL, APPROVER)).missingRequired, 0);
  });
  test("a question the gate lists as unmet is unanswered, whatever the columns say", () => {
    const rows = buildReviewRows({ ...FULL, unmetQualification: new Set(["people_identified"]) }, APPROVER);
    assert.equal(rows.find((r) => r.key === "qualification:people_identified")!.answered, false);
    assert.equal(rows.find((r) => r.key === "qualification:trial_plan")!.answered, true);
  });
  test("a blank lead shows every required answer as missing", () => {
    const t = reviewTally(buildReviewRows(EMPTY, APPROVER));
    /* Six Suspect rows now carry a required question (customer type, litres, product,
       competitor, GST, application), plus next action and the six Qualification rows. */
    assert.equal(t.missingRequired, 13);
  });
});

describe("what an approver may edit — and what the CRM keeps for the Salesman", () => {
  test("a viewer who is not the designated approver gets no editable box at all", () => {
    const rows = buildReviewRows(FULL, READER);
    assert.equal(rows.flatMap((r) => r.fields).filter((f) => f.editKey).length, 0);
  });
  test("one stored answer is edited in one place only", () => {
    const keys = buildReviewRows(FULL, APPROVER).flatMap((r) => r.fields).filter((f) => f.editKey).map((f) => f.editKey);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(keys.includes("requiredProductId"));
  });
  test("the Calling Desk's address and email, next action and history are read only", () => {
    const rows = buildReviewRows(FULL, APPROVER);
    for (const [k, id] of [["suspect:address", "address"], ["suspect:email", "email"], ["prospect:next_action", "next_action"], ["prospect:prospect_reason", "prospect_reason"]]) {
      assert.equal(fieldOf(rows, k, id).editKey, null, k);
    }
  });
  test("the Sales Manager approver edits Suspect/Prospect answers", () => {
    const rows = buildReviewRows(FULL, SALES_MANAGER);
    for (const [k, id] of [["suspect:competitor", "competitor"], ["suspect:monthlyLitres", "monthlyLitres"], ["suspect:customerType", "customerType"], ["prospect:contact_person", "contactPerson"]]) {
      assert.equal(fieldOf(rows, k, id).editKey, id, k);
    }
  });
  test("…and the Qualification-only answers are READ ONLY for them, with the CRM's own sentence", () => {
    const rows = buildReviewRows(FULL, SALES_MANAGER);
    for (const [k, id] of [
      ["suspect:gstin", "gstin"], ["suspect:application", "application"], ["suspect:buyer", "buyer"], ["suspect:creditDaysWanted", "creditDaysWanted"],
      ["qualification:trial_plan", "trial_product"], ["qualification:price_and_credit", "price_range"], ["qualification:next_step_dated", "next_step"],
    ]) {
      const f = fieldOf(rows, k, id);
      assert.equal(f.editKey, null, k);
      assert.match(f.readOnlyReason ?? "", /Salesman who owns this lead completes its Qualification/, k);
    }
  });
  test("a designated approver who is not the seat holder can edit the Qualification answers too", () => {
    assert.equal(fieldOf(buildReviewRows(FULL, APPROVER), "qualification:trial_plan", "trial_product").editKey, "trial_product");
  });
  test("a distributor's checklist is not editable from here", () => {
    const rows = buildReviewRows({ ...FULL, salesType: "distributor" }, APPROVER);
    assert.ok(rows.filter((r) => r.section === "qualification").every((r) => r.fields.every((f) => f.editKey === null)));
  });
  test("isCollectorEdit names exactly what the CRM's writers keep for the collector", () => {
    for (const k of ["gstin", "application", "creditDaysWanted", "buyer", "trial_product", "next_step_date"]) assert.equal(isCollectorEdit(k), true, k);
    for (const k of ["competitor", "monthlyLitres", "customerType", "contactPerson", "decisionMaker", "requiredProductId"]) assert.equal(isCollectorEdit(k), false, k);
  });
});

describe("splitEdits refuses what the review does not edit", () => {
  test("allowed names pass", () => {
    assert.deepEqual(splitEdits({ fields: { competitor: "x", monthlyLitres: 5 }, answers: { price_range: "y" } }).refused, []);
  });
  test("stage, owner, verdict and review columns are refused by name", () => {
    const s = splitEdits({
      fields: { leadStage: "won", ownerId: "x", leadQualificationReview: "verified", gstVerified: 1, potentialPaise: 5 } as never,
      answers: { gst_verified: "yes" } as never,
    });
    assert.deepEqual(s.refused.sort(), ["gst_verified", "gstVerified", "leadQualificationReview", "leadStage", "ownerId", "potentialPaise"].sort());
  });
  test("a stray top-level key is refused", () => {
    assert.deepEqual(splitEdits({ verdict: "verified" } as never).refused, ["verdict"]);
  });
});

describe("the audit describes changes without leaking more than it must", () => {
  test("a GST number is masked to its state code and last three", () => {
    assert.equal(maskGstin("27ABCDE1234F1Z5"), "27••••••••••1Z5");
  });
  test("diffAnswers lists only what really differs, with before and after", () => {
    const d = diffAnswers(
      ["competitor", "monthlyLitres", "gstin", "buyer"],
      { competitor: "A", monthlyLitres: 300, gstin: "27ABCDE1234F1Z5", buyer: "" },
      { competitor: "B", monthlyLitres: "300", gstin: "29ZZZZZ9999Z1Z1", buyer: null },
    );
    assert.deepEqual(d.map((c) => c.field), ["competitor", "gstin"]);
    assert.deepEqual([d[0].from, d[0].to], ["A", "B"]);
    assert.ok(!JSON.stringify(d).includes("ABCDE1234"));
  });
  test("long free text is capped in the log", () => {
    assert.equal(String(auditValue("application", "x".repeat(500))).length, 200);
  });
});

describe("Confirm blockers are the gate's own", () => {
  test("a lead with nothing answered names what is missing", () => {
    const gate: LeadGateInput = { salesType: "direct", stage: "qualification" };
    assert.ok(confirmBlockers(gate).length >= 1);
  });
});
