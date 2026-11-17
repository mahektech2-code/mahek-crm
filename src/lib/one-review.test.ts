import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  auditLog,
  customers,
  leadStageTransitions,
  mbosLeadValidations,
  notifications,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { recordLeadValidationCall, saveLeadQualification, saveProspectFields } from "@/lib/actions/leads";
import { confirmProspectReview } from "@/lib/actions/prospect-review";
import { reviewLeadQualification } from "@/lib/actions/lead-qualification-review";
import { saveQualificationReviewEdits } from "@/lib/actions/lead-qualification-review-edit";
import { loadQualificationReview } from "@/lib/services/lead-qualification-review-service";
import { QUAL_NEXT } from "@/lib/qualification-next";
import { QUALIFICATION_ANSWERS } from "@/lib/qualification-fixtures";
import { PROSPECT_REVIEW_NEXT } from "@/lib/prospect-review";
import { testPhone } from "@/lib/test-phone";

/* ---------------------------------------------------------------------------
 * THE ONE REVIEW, end to end against the real services.
 *
 * A lead reaches Prospect and goes to its Sales Manager. She answers ONE review —
 * every question once, Qualification's included — saves it, may ring the customer
 * or not, and a single Confirm verifies the Prospect, completes Qualification and
 * moves the lead to Sample / Trial. No Telecaller Qualification step in between.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const DAY = "2026-09-29";
let owner: typeof users.$inferSelect;
let mgr: typeof users.$inferSelect;
let otherMgr: typeof users.$inferSelect;
let productId: string;

async function makeUser(name: string, role: "associate" | "manager") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role });
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "sales", role });
  return row;
}

/** A Prospect with every Suspect and Prospect answer in and NOTHING of Qualification answered. */
const prospect = async (over: Partial<typeof customers.$inferInsert> = {}) => {
  const [lead] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      contactPerson: "Ganesh",
      phone: testPhone(),
      city: "Nashik",
      kind: "lead",
      leadStage: "prospect",
      leadSalesType: "direct",
      leadSource: "manual",
      customerType: "retailer",
      ownerId: owner.id,
      leadManagerId: mgr.id,
      salesManagerId: mgr.id,
      leadMonthlyVolumeLitres: 300,
      leadEstimatedPotentialPaise: 9_000_000,
      leadCompetitor: "Local thinner",
      leadRequiredProductId: productId,
      leadDecisionMaker: "Owner",
      gstin: "27ABCDE1234F1Z5",
      leadApplication: "Wood polish",
      leadCreditDaysWanted: 30,
      leadBuyer: "The owner's brother",
      leadNextAction: PROSPECT_REVIEW_NEXT.review,
      leadNextActionDate: DAY,
      leadNextActionOwnerId: mgr.id,
      ...over,
    })
    .returning();
  await db.insert(leadStageTransitions).values({
    id: id("lst"), customerId: lead.id, fromStage: "suspect", toStage: "prospect", salesType: over.leadSalesType ?? "direct",
    reasonCode: "high_consumption", actorId: owner.id,
  });
  return lead;
};

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const stages = async (leadId: string) =>
  (await db.select().from(leadStageTransitions).where(eq(leadStageTransitions.customerId, leadId)).orderBy(leadStageTransitions.at))
    .map((t) => t.toStage);
const calls = (leadId: string) => db.select().from(mbosLeadValidations).where(eq(mbosLeadValidations.customerId, leadId));
const told = async (userId: string) => (await db.select().from(notifications).where(eq(notifications.userId, userId))).map((n) => n.title);

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against a mahekone_test database.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_stage_transitions, mbos_lead_validations, mbos_tasks, notifications, timeline_events,
      audit_log, app_module_access, app_access, customers, products, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  owner = await makeUser("Tara Telecaller", "associate");
  mgr = await makeUser("Manoj Manager", "manager");
  otherMgr = await makeUser("Omkar Other", "manager");
  await db.update(users).set({ reportsToId: mgr.id }).where(eq(users.id, owner.id));
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
  setTestUser(mgr);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("the one review draws every question once, Qualification's six included", () => {
  test("20 rows, the six Qualification rows editable by the verifier, GST waiting for her tick", async () => {
    const lead = await prospect();
    const m = await loadQualificationReview(lead.id, mgr);
    assert.ok(m);
    assert.equal(m.kind, "prospect");
    assert.equal(m.combined, true);
    assert.equal(m.rows.length, 20);
    const boxes = m.rows.flatMap((r) => r.fields.map((f) => f.id));
    assert.equal(new Set(boxes).size, boxes.length, "a box is drawn twice");
    const q = m.rows.filter((r) => r.section === "qualification");
    assert.equal(q.length, 6, "all six Qualification-only questions are in the review");
    assert.ok(q.every((r) => r.fields.some((f) => f.editKey)), "the verifier can answer each of them");
    assert.equal(m.gstNeedsCheck, true);
    assert.ok(m.blockers.length > 0, "Confirm is held until they are answered");
    assert.deepEqual(m.call, { saved: false });
  });

  test("a viewer who is not the verifier gets no edit box", async () => {
    const lead = await prospect();
    const m = await loadQualificationReview(lead.id, otherMgr);
    assert.ok(m);
    assert.equal(m.viewer.canDecide, false);
    assert.equal(m.rows.flatMap((r) => r.fields).filter((f) => f.editKey).length, 0);
  });
});

describe("Confirm completes Qualification and moves the lead to Sample / trial", () => {
  test("refused while a Qualification answer is missing, and nothing changes", async () => {
    const lead = await prospect();
    const r = await confirmProspectReview({ customerId: lead.id, gstChecked: true });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Not ready to confirm/);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect");
    assert.equal(after.leadVerifiedAt, null);
    assert.equal(after.leadQualificationReview, null);
    assert.equal(after.gstVerified, false, "the GST tick is not applied by a refused confirm");
  });

  test("the whole journey: save the answers, skip the call, tick GST, Confirm", async () => {
    const lead = await prospect();
    const saved = await saveQualificationReviewEdits({ customerId: lead.id, edits: { answers: { ...QUALIFICATION_ANSWERS } } });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.error);
    const afterSave = await row(lead.id);
    assert.equal(afterSave.leadStage, "prospect", "saving moves nothing");
    assert.equal(afterSave.leadVerifiedAt, null);
    assert.equal(afterSave.leadQualificationReview, null);
    assert.deepEqual((await loadQualificationReview(lead.id, mgr))!.call, { saved: true }, "the call is offered after the save");

    /* GST has not been ticked: held, in words, and nothing written. */
    const noTick = await confirmProspectReview({ customerId: lead.id });
    assert.equal(noTick.ok, false);
    if (!noTick.ok) assert.match(noTick.error, /GST/);
    assert.equal((await row(lead.id)).leadStage, "prospect");

    const r = await confirmProspectReview({ customerId: lead.id, gstChecked: true });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    if (r.ok) assert.match(r.message ?? "", /Sample \/ trial/);

    const after = await row(lead.id);
    assert.equal(after.leadStage, "sample_trial", `straight to Sample / trial — ${r.ok ? r.message : ""}`);
    assert.equal(after.leadVerifiedById, mgr.id);
    assert.equal(after.leadQualificationReview, "verified");
    assert.equal(after.gstVerified, true);
    assert.ok(after.leadFiguresConfirmedAt, "she has just read the figures");
    assert.equal(after.leadNextAction, QUAL_NEXT.sample);
    assert.equal(after.leadNextActionOwnerId, owner.id, "the sample is the owner's to request");
    assert.deepEqual((await stages(lead.id)).slice(-2), ["qualification", "sample_trial"], "Qualification is passed through, not skipped");
    assert.equal((await calls(lead.id)).length, 0, "no call was needed");

    const titles = await told(owner.id);
    assert.ok(titles.some((t) => /qualification is complete/.test(t)), "the owner is told the lead is at Sample / trial");
    assert.ok(!titles.some((t) => /qualification is ready for you/.test(t)), "and is not sent to do a Qualification step that is done");
    const reviewerTitles = await told(mgr.id);
    assert.ok(
      !reviewerTitles.some((t) => /ready for your review/.test(t)),
      "and the Sales Manager is not told to review what she has just reviewed",
    );
  });

  test("the call is optional: one made before Confirm changes nothing about it", async () => {
    const lead = await prospect();
    assert.equal((await saveQualificationReviewEdits({ customerId: lead.id, edits: { answers: { ...QUALIFICATION_ANSWERS } } })).ok, true);
    const call = await recordLeadValidationCall(lead.id, { answers: {}, outcome: "follow_up", followUpNote: "Ring again tomorrow" });
    assert.equal(call.ok, true, call.ok ? "" : call.error);
    const r = await confirmProspectReview({ customerId: lead.id, gstChecked: true });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadStage, "sample_trial");
    assert.equal((await calls(lead.id)).length, 1, "the call is kept");
  });

  test("an unchanged save also counts as saving the review", async () => {
    const lead = await prospect();
    const r = await saveQualificationReviewEdits({ customerId: lead.id, edits: {} });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await loadQualificationReview(lead.id, mgr))!.call?.saved, true);
  });

  test("the audit trail names the verdict and who gave it", async () => {
    const lead = await prospect();
    await saveQualificationReviewEdits({ customerId: lead.id, edits: { answers: { ...QUALIFICATION_ANSWERS } } });
    await confirmProspectReview({ customerId: lead.id, gstChecked: true });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.entityId, lead.id), eq(auditLog.action, "lead.qualificationReview")));
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actorId, mgr.id);
  });
});

describe("permissions are unchanged", () => {
  test("only the verifier saves the Qualification answers, and only through the review", async () => {
    const lead = await prospect();
    for (const u of [owner, otherMgr]) {
      setTestUser(u);
      const r = await saveQualificationReviewEdits({ customerId: lead.id, edits: { answers: { trial_product: "x" } } });
      assert.equal(r.ok, false, u.name);
    }
    assert.deepEqual((await row(lead.id)).leadQualification, {});
  });

  test("the Sales Manager is STILL refused those answers anywhere else — the review's allowance does not leak", async () => {
    const lead = await prospect();
    setTestUser(mgr);
    const direct = await saveLeadQualification(lead.id, { trial_product: "x" });
    assert.equal(direct.ok, false, "saveLeadQualification outside the review");
    const field = await saveProspectFields(lead.id, { application: "x" });
    assert.equal(field.ok, false, "saveProspectFields for a Qualification-only field outside the review");
    const after = await row(lead.id);
    assert.deepEqual(after.leadQualification, {});
    assert.equal(after.leadApplication, "Wood polish");
  });

  test("only the designated verifier may Confirm", async () => {
    const lead = await prospect();
    await saveQualificationReviewEdits({ customerId: lead.id, edits: { answers: { ...QUALIFICATION_ANSWERS } } });
    for (const u of [owner, otherMgr]) {
      setTestUser(u);
      assert.equal((await confirmProspectReview({ customerId: lead.id, gstChecked: true })).ok, false, u.name);
    }
    assert.equal((await row(lead.id)).leadStage, "prospect");
  });
});

describe("what the one review does NOT change", () => {
  test("a distributor keeps the Prospect-only review", async () => {
    const lead = await prospect({ leadSalesType: "distributor" });
    const m = await loadQualificationReview(lead.id, mgr);
    assert.ok(m);
    assert.equal(m.combined, false);
    assert.ok(m.rows.every((r) => r.section !== "qualification"));
  });

  test("a third-party lead with no distributor named is held by the ordinary gate, in words", async () => {
    const lead = await prospect({ leadSalesType: "third_party" });
    await saveQualificationReviewEdits({ customerId: lead.id, edits: { answers: { ...QUALIFICATION_ANSWERS } } });
    const r = await confirmProspectReview({ customerId: lead.id, gstChecked: true });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /distributor/i);
    assert.equal((await row(lead.id)).leadStage, "prospect");
  });

  test("Return for correction is untouched", async () => {
    const lead = await prospect();
    const { returnProspectForCorrection } = await import("@/lib/actions/prospect-review");
    const r = await returnProspectForCorrection({ customerId: lead.id, note: "Ask about credit" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadStage, "prospect");
  });
});

describe("Confirming at Qualification moves the lead on too", () => {
  test("a lead already at Qualification with every answer in goes to Sample / trial when confirmed", async () => {
    const lead = await prospect({
      leadStage: "qualification",
      leadVerifiedAt: new Date(),
      leadVerifiedById: mgr.id,
      gstVerified: true,
      gstVerifiedAt: new Date(),
      gstVerifiedById: mgr.id,
      leadFiguresConfirmedAt: new Date(),
      leadQualification: { ...QUALIFICATION_ANSWERS },
      leadNextAction: QUAL_NEXT.review,
      leadNextActionOwnerId: mgr.id,
    });
    await db.insert(leadStageTransitions).values({
      id: id("lst"), customerId: lead.id, fromStage: "prospect", toStage: "qualification", salesType: "direct", actorId: mgr.id,
    });
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadStage, "sample_trial");
    assert.equal((await row(lead.id)).leadQualificationReview, "verified");
  });

  test("rejecting still holds the lead at Qualification", async () => {
    const lead = await prospect({
      leadStage: "qualification",
      leadVerifiedAt: new Date(),
      leadVerifiedById: mgr.id,
      leadQualification: { ...QUALIFICATION_ANSWERS },
      leadNextAction: QUAL_NEXT.review,
      leadNextActionOwnerId: mgr.id,
    });
    await db.insert(leadStageTransitions).values({
      id: id("lst"), customerId: lead.id, fromStage: "prospect", toStage: "qualification", salesType: "direct", actorId: mgr.id,
    });
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "incomplete", note: "Credit terms are missing" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "qualification");
    assert.equal(after.leadQualificationReview, "incomplete");
  });
});

