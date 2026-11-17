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
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { reviewLeadQualification } from "@/lib/actions/lead-qualification-review";
import { saveQualificationReviewEdits } from "@/lib/actions/lead-qualification-review-edit";
import { recordLeadValidationCall } from "@/lib/actions/leads";
import { loadQualificationReview } from "@/lib/services/lead-qualification-review-service";
import { callRefusalFor } from "@/lib/services/qualification-call-gate";
import { managerCalls } from "@/lib/services/lead-console-service";
import { sampleEligibility, QUAL_NEXT } from "@/lib/services/lead-qualification-flow-service";
import { QUALIFICATION_ANSWERS } from "@/lib/qualification-fixtures";
import { REVIEW_SAVED_ACTION } from "@/lib/qualification-review";
import { testPhone } from "@/lib/test-phone";

/* ---------------------------------------------------------------------------
 * THE CONSOLIDATED QUALIFICATION REVIEW, and the optional call that follows its
 * save — against the real services.
 *
 * The cast: a Salesman who owns the lead and collected its Qualification, the
 * designated approver (the lead manager seat), another manager who may see the
 * lead but is not the approver, and a stranger.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const DAY = "2026-09-29";

let owner: typeof users.$inferSelect;
let approver: typeof users.$inferSelect;
let otherMgr: typeof users.$inferSelect;
let stranger: typeof users.$inferSelect;
let productId: string;

async function makeUser(name: string, role: "associate" | "manager" | "admin") {
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
  return row;
}

/** A lead at Qualification with every question answered, entered Qualification just now. */
async function qualificationLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [lead] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      contactPerson: "Ganesh",
      phone: testPhone(),
      city: "Nashik",
      kind: "lead",
      leadStage: "qualification",
      leadSalesType: "direct",
      leadSource: "manual",
      ownerId: owner.id,
      leadManagerId: approver.id,
      backOfficeAmId: otherMgr.id /* gives otherMgr SIGHT of the lead and nothing else */,
      customerType: "retailer",
      leadMonthlyVolumeLitres: 300,
      leadEstimatedPotentialPaise: 9_000_000,
      leadCompetitor: "Local thinner",
      leadRequiredProductId: productId,
      leadDecisionMaker: "Owner",
      leadVerifiedAt: new Date(),
      leadVerifiedById: approver.id,
      leadNextAction: QUAL_NEXT.review,
      leadNextActionDate: DAY,
      leadNextActionOwnerId: approver.id,
      gstin: "27ABCDE1234F1Z5",
      gstVerified: true,
      gstVerifiedAt: new Date(),
      gstVerifiedById: approver.id,
      leadApplication: "Wood polish",
      leadCreditDaysWanted: 30,
      leadBuyer: "Ganesh's brother",
      leadFiguresConfirmedAt: new Date(),
      leadQualification: { ...QUALIFICATION_ANSWERS },
      ...over,
    })
    .returning();
  await db.insert(leadStageTransitions).values({
    id: id("lst"), customerId: lead.id, fromStage: "suspect", toStage: "prospect", salesType: "direct",
    reasonCode: "high_consumption", actorId: owner.id,
  });
  await db.insert(leadStageTransitions).values({
    id: id("lst"), customerId: lead.id, fromStage: "prospect", toStage: "qualification", salesType: "direct", actorId: approver.id,
  });
  return lead;
}

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const savedMarks = (leadId: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.entityId, leadId), eq(auditLog.action, REVIEW_SAVED_ACTION)));
const validations = (leadId: string) => db.select().from(mbosLeadValidations).where(eq(mbosLeadValidations.customerId, leadId));
/** The cheapest valid call that is not a verdict on the lead. */
const followUpCall = (leadId: string) =>
  recordLeadValidationCall(leadId, { answers: {}, outcome: "follow_up", followUpNote: "Ring again tomorrow" });

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against a mahekone_test* database.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_stage_transitions, lead_verification_corrections, mbos_lead_validations, mbos_tasks,
      mbos_samples, sample_feedback, mbos_approvals, mbos_devices, mbos_user_territories, customer_distributors,
      calls, notifications, timeline_events, audit_log, app_module_access, app_access, customers, products,
      users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  owner = await makeUser("Sonu Salesman", "associate");
  approver = await makeUser("Vikas Verifier", "manager");
  otherMgr = await makeUser("Omkar Other", "manager");
  stranger = await makeUser("Sam Stranger", "associate");
  await db.update(users).set({ reportsToId: approver.id }).where(eq(users.id, owner.id));
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
  setTestUser(approver);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ============================================================ ONE CONSOLIDATED REVIEW */

describe("the consolidated review shows each question once, with the answers already saved", () => {
  test("19 unique rows, no stored answer boxed twice, and the repeats are gone", async () => {
    const lead = await qualificationLead();
    const m = await loadQualificationReview(lead.id, approver);
    assert.ok(m);
    assert.equal(m.kind, "qualification");
    assert.equal(m.rows.length, 19);
    assert.equal(m.tally.total, 19);
    const boxes = m.rows.flatMap((r) => r.fields.map((f) => f.id));
    assert.equal(new Set(boxes).size, boxes.length, "a box is drawn twice");
    for (const gone of ["prospect:gstin", "prospect:customer_type", "prospect:monthly_litres", "prospect:competitor", "prospect:required_product", "qualification:gst_verified", "qualification:application_understood"]) {
      assert.equal(m.rows.some((r) => r.key === gone), false, gone);
    }
  });

  test("existing answers show on the one row that carries them", async () => {
    const lead = await qualificationLead();
    const m = await loadQualificationReview(lead.id, approver);
    assert.ok(m);
    const f = (rowKey: string, fieldId: string) => m.rows.find((r) => r.key === rowKey)!.fields.find((x) => x.id === fieldId)!;
    assert.match(f("suspect:gstin", "gstin").display, /27ABCDE1234F1Z5 \(Verified\)/);
    assert.equal(f("suspect:application", "application").value, "Wood polish");
    assert.equal(f("suspect:buyer", "buyer").value, "Ganesh's brother");
    assert.equal(f("suspect:competitor", "competitor").value, "Local thinner");
    assert.equal(f("suspect:monthlyLitres", "monthlyLitres").display, "300 Litres");
    /* …and Qualification's own questions keep their saved answers too. */
    assert.equal(f("qualification:trial_plan", "trial_product").value, QUALIFICATION_ANSWERS.trial_product);
  });

  test("the Prospect-stage review is the 14 rows before Qualification opens", async () => {
    const lead = await qualificationLead({ leadStage: "prospect", leadVerifiedAt: null, leadVerifiedById: null, leadNextAction: "Verify this Prospect" });
    const m = await loadQualificationReview(lead.id, approver);
    assert.ok(m);
    assert.equal(m.kind, "prospect");
    assert.equal(m.rows.length, 14);
    assert.equal(m.call, null, "no call is offered before Qualification");
  });
});

/* ============================================ THE CALL COMES AFTER THE REVIEW IS SAVED */

describe("the verification call is offered only after the review has been saved", () => {
  test("before the save: the model offers no call, and the action refuses one in words", async () => {
    const lead = await qualificationLead();
    const m = await loadQualificationReview(lead.id, approver);
    assert.deepEqual(m!.call, { saved: false });
    assert.match((await callRefusalFor(lead.id)) ?? "", /opens once the Qualification review has been saved/);
    const r = await followUpCall(lead.id);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /opens once the Qualification review has been saved/);
    assert.equal((await validations(lead.id)).length, 0, "nothing was recorded");
  });

  test("after Save changes with a correction: the change is stored, the mark is written, the call is accepted", async () => {
    const lead = await qualificationLead();
    const saved = await saveQualificationReviewEdits({ customerId: lead.id, edits: { fields: { competitor: "Berger" } } });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.error);
    assert.equal((await row(lead.id)).leadCompetitor, "Berger");
    assert.equal((await savedMarks(lead.id)).length, 1);
    assert.deepEqual((await loadQualificationReview(lead.id, approver))!.call, { saved: true });
    assert.equal(await callRefusalFor(lead.id), null);
    const r = await followUpCall(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await validations(lead.id)).length, 1);
  });

  test("Save changes with nothing to correct also counts as saving the review", async () => {
    const lead = await qualificationLead();
    const saved = await saveQualificationReviewEdits({ customerId: lead.id, edits: {} });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.error);
    if (saved.ok) assert.equal(saved.data.changed, 0);
    assert.equal((await savedMarks(lead.id)).length, 1);
    assert.equal((await followUpCall(lead.id)).ok, true);
  });

  test("a save before Qualification opens still has nothing to save, and offers no call", async () => {
    const lead = await qualificationLead({ leadStage: "prospect", leadVerifiedAt: null, leadVerifiedById: null, leadNextAction: "Verify this Prospect" });
    const r = await saveQualificationReviewEdits({ customerId: lead.id, edits: {} });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /nothing to save/i);
    assert.equal((await savedMarks(lead.id)).length, 0);
  });

  test("a failed or refused save writes no mark and does not open the call", async () => {
    const lead = await qualificationLead();
    setTestUser(otherMgr); /* sees the lead, is not the approver */
    const r = await saveQualificationReviewEdits({ customerId: lead.id, edits: { fields: { competitor: "Berger" } } });
    assert.equal(r.ok, false);
    assert.equal((await savedMarks(lead.id)).length, 0);
    setTestUser(approver);
    assert.notEqual(await callRefusalFor(lead.id), null, "still locked");
    assert.equal((await followUpCall(lead.id)).ok, false);
    /* A Salesman's save (the owner) and a stranger's are refused the same way. */
    for (const u of [owner, stranger]) {
      setTestUser(u);
      assert.equal((await saveQualificationReviewEdits({ customerId: lead.id, edits: {} })).ok, false, u.name);
    }
    assert.equal((await savedMarks(lead.id)).length, 0);
  });

  test("an unchanged save by the approver does not touch the answers, the verdict or the next action", async () => {
    const lead = await qualificationLead();
    const before = await row(lead.id);
    assert.equal((await saveQualificationReviewEdits({ customerId: lead.id, edits: {} })).ok, true);
    const now = await row(lead.id);
    assert.equal(now.leadStage, "qualification");
    assert.equal(now.leadQualificationReview, null, "saving is not approving");
    assert.equal(now.leadNextAction, before.leadNextAction);
    assert.equal(now.leadNextActionOwnerId, before.leadNextActionOwnerId);
    assert.deepEqual(now.leadQualification, before.leadQualification, "every saved answer is as it was");
    assert.equal(now.gstin, before.gstin);
  });
});

describe("a save from an earlier stay in Qualification does not open the call for this one", () => {
  test("the mark counts only for the stay it was made in", async () => {
    const lead = await qualificationLead();
    assert.equal((await saveQualificationReviewEdits({ customerId: lead.id, edits: {} })).ok, true);
    assert.equal(await callRefusalFor(lead.id), null);
    /* The lead is sent back and enters Qualification again, later. */
    await db.insert(leadStageTransitions).values({
      id: id("lst"), customerId: lead.id, fromStage: "prospect", toStage: "qualification", salesType: "direct", actorId: approver.id,
      at: new Date(Date.now() + 60_000),
    });
    assert.notEqual(await callRefusalFor(lead.id), null);
  });

  test("a call recorded earlier stays readable even when the call is locked again", async () => {
    const lead = await qualificationLead();
    assert.equal((await saveQualificationReviewEdits({ customerId: lead.id, edits: {} })).ok, true);
    assert.equal((await followUpCall(lead.id)).ok, true);
    await db.insert(leadStageTransitions).values({
      id: id("lst"), customerId: lead.id, fromStage: "prospect", toStage: "qualification", salesType: "direct", actorId: approver.id,
      at: new Date(Date.now() + 60_000),
    });
    assert.notEqual(await callRefusalFor(lead.id), null);
    assert.equal((await managerCalls(lead.id)).length, 1, "the earlier call is still there");
    assert.equal((await validations(lead.id)).length, 1);
  });
});

describe("the call is gated only where there is a review to save", () => {
  test("a Prospect is verified as before — by the review or by the call — and the gate stays out of it", async () => {
    const lead = await qualificationLead({ leadStage: "prospect", leadVerifiedAt: null, leadVerifiedById: null, leadNextAction: "Verify this Prospect" });
    assert.equal(await callRefusalFor(lead.id), null);
  });

  test("a lead already past Qualification is not held either", async () => {
    const lead = await qualificationLead({ leadStage: "sample_trial" });
    assert.equal(await callRefusalFor(lead.id), null);
  });

  test("a distributor's checklist has no review to save, so it is left alone", async () => {
    const lead = await qualificationLead({ leadSalesType: "distributor" });
    assert.equal(await callRefusalFor(lead.id), null);
    assert.equal((await loadQualificationReview(lead.id, approver))!.call, null);
  });
});

/* ============================================ THE CALL IS NEVER REQUIRED */

describe("skipping the call blocks nothing", () => {
  test("confirm qualification works with no call ever made, and the lead may then be sent a sample", async () => {
    const lead = await qualificationLead();
    assert.equal((await saveQualificationReviewEdits({ customerId: lead.id, edits: {} })).ok, true);
    /* …and the approver simply does not call. */
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadQualificationReview, "verified");
    assert.equal((await validations(lead.id)).length, 0, "no call was made or needed");
    const e = await sampleEligibility(lead.id);
    assert.deepEqual(e, { applies: true, eligible: true });
  });

  test("confirming does not even need the review to have been saved first — the save is not an approval step", async () => {
    const lead = await qualificationLead();
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadQualificationReview, "verified");
  });

  test("rejecting works with no call, with the same rules as before", async () => {
    const lead = await qualificationLead();
    const noNote = await reviewLeadQualification({ customerId: lead.id, verdict: "incomplete" });
    assert.equal(noNote.ok, false, "a rejection still needs its sentence");
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "incomplete", note: "Ask about credit" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadQualificationReview, "incomplete");
  });

  test("the verdict permissions are unchanged: only the designated approver decides", async () => {
    const lead = await qualificationLead();
    for (const u of [otherMgr, owner, stranger]) {
      setTestUser(u);
      assert.equal((await reviewLeadQualification({ customerId: lead.id, verdict: "verified" })).ok, false, u.name);
    }
    assert.equal((await row(lead.id)).leadQualificationReview, null);
  });

  test("a call made after the decision is still accepted, and does not undo it", async () => {
    const lead = await qualificationLead();
    assert.equal((await saveQualificationReviewEdits({ customerId: lead.id, edits: {} })).ok, true);
    assert.equal((await reviewLeadQualification({ customerId: lead.id, verdict: "verified" })).ok, true);
    const c = await followUpCall(lead.id);
    assert.equal(c.ok, true, c.ok ? "" : c.error);
    assert.equal((await row(lead.id)).leadQualificationReview, "verified");
    assert.equal((await row(lead.id)).leadStage, "qualification");
  });
});
