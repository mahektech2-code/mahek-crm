import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, auditLog, customers, mbosLeadValidations, notifications, products, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { recordLeadValidationCall } from "@/lib/actions/leads";
import { verifyProspect } from "@/lib/actions/sales-manager-pipeline";
import { confirmProspectReview, resubmitProspectForReview, returnProspectForCorrection } from "@/lib/actions/prospect-review";
import { loadQualificationReview } from "@/lib/services/lead-qualification-review-service";
import { PROSPECT_REVIEW_AUDIT, PROSPECT_REVIEW_NEXT } from "@/lib/prospect-review";

/* ---------------------------------------------------------------------------
 * THE PROSPECT REVIEW, run against the real database: Confirm, Return,
 * Resubmit, and who is refused. Org-chart routing is off here, so the person who
 * may decide is the lead's own Sales Manager seat holder — a `lead.verify`
 * holder who is not the seat is refused and told what configuration is missing.
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
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role });
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "sales", role });
  return row;
}

const prospect = async (over: Partial<typeof customers.$inferInsert> = {}) =>
  (
    await db
      .insert(customers)
      .values({
        id: id("cus"),
        name: `Lead ${randomUUID().slice(0, 6)}`,
        contactPerson: "Ganesh",
        phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
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
      .returning()
  )[0];

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const auditCount = async (leadId: string, action: string) =>
  (await db.select().from(auditLog).where(and(eq(auditLog.entityId, leadId), eq(auditLog.action, action)))).length;

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

describe("the review shows Suspect and Prospect answers only", () => {
  test("no Qualification-only question is shown or counted as missing", async () => {
    const lead = await prospect();
    const model = await loadQualificationReview(lead.id, mgr);
    assert.ok(model);
    assert.equal(model.kind, "prospect");
    assert.equal(model.viewer.canDecide, true);
    assert.ok(model.rows.length > 0);
    assert.ok(model.rows.every((r) => r.section !== "qualification"), "a Qualification row leaked in");
    assert.equal(model.tally.total, model.rows.length);
  });
});

describe("Confirm", () => {
  test("verifies a complete Prospect and opens Qualification, with no call", async () => {
    const lead = await prospect();
    const r = await confirmProspectReview({ customerId: lead.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "qualification");
    assert.equal(after.leadVerifiedById, mgr.id);
    assert.ok(after.leadVerifiedAt);
    assert.equal(
      (await db.select().from(mbosLeadValidations).where(eq(mbosLeadValidations.customerId, lead.id))).length,
      0,
      "no call was needed",
    );
    assert.equal(await auditCount(lead.id, PROSPECT_REVIEW_AUDIT.confirm), 1);
  });

  test("is refused while a required Prospect answer is missing, and nothing changes", async () => {
    const lead = await prospect({ gstin: null, leadCompetitor: null });
    const r = await confirmProspectReview({ customerId: lead.id });
    assert.equal(r.ok, false);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect");
    assert.equal(after.leadVerifiedAt, null);
  });

  test("is refused to everyone but the designated verifier", async () => {
    for (const who of [owner, otherMgr]) {
      const lead = await prospect();
      setTestUser(who);
      const r = await confirmProspectReview({ customerId: lead.id });
      assert.equal(r.ok, false, `${who.name} was allowed to confirm`);
      const after = await row(lead.id);
      assert.equal(after.leadStage, "prospect");
      assert.equal(after.leadVerifiedAt, null);
    }
  });

  test("a verifier who is not the seat is told what routing is missing", async () => {
    const lead = await prospect();
    setTestUser(otherMgr);
    const r = await confirmProspectReview({ customerId: lead.id });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /designated verifier|org chart|Sales Manager/i);
  });
});

describe("Return and Resubmit", () => {
  test("Return needs a reason, keeps every answer, tells the owner and is audited", async () => {
    const lead = await prospect();
    const none = await returnProspectForCorrection({ customerId: lead.id, note: "  " });
    assert.equal(none.ok, false);
    assert.equal((await row(lead.id)).leadNextAction, PROSPECT_REVIEW_NEXT.review, "nothing changed without a reason");

    const r = await returnProspectForCorrection({ customerId: lead.id, note: "Competitor looks wrong" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect");
    assert.equal(after.leadNextAction, PROSPECT_REVIEW_NEXT.returned);
    assert.equal(after.leadNextActionOwnerId, owner.id);
    assert.equal(after.leadCompetitor, "Local thinner", "every answer is kept");
    assert.equal(await auditCount(lead.id, PROSPECT_REVIEW_AUDIT.returned), 1);
    const told = await db.select().from(notifications).where(eq(notifications.userId, owner.id));
    assert.ok(told.some((n) => /Competitor looks wrong/.test(n.body ?? "")));
  });

  test("a returned Prospect cannot be confirmed until resubmitted, and only its owner resubmits", async () => {
    const lead = await prospect();
    await returnProspectForCorrection({ customerId: lead.id, note: "Fix the buyer" });

    assert.equal((await confirmProspectReview({ customerId: lead.id })).ok, false);

    setTestUser(otherMgr);
    assert.equal((await resubmitProspectForReview(lead.id)).ok, false, "not the owner");

    setTestUser(owner);
    const re = await resubmitProspectForReview(lead.id);
    assert.equal(re.ok, true, re.ok ? "" : re.error);
    assert.equal((await row(lead.id)).leadNextAction, PROSPECT_REVIEW_NEXT.review);
    assert.equal(await auditCount(lead.id, PROSPECT_REVIEW_AUDIT.resubmit), 1);

    setTestUser(mgr);
    const done = await confirmProspectReview({ customerId: lead.id });
    assert.equal(done.ok, true, done.ok ? "" : done.error);
    assert.equal((await row(lead.id)).leadStage, "qualification");
  });

  test("an unauthorised person cannot return it", async () => {
    const lead = await prospect();
    setTestUser(otherMgr);
    const r = await returnProspectForCorrection({ customerId: lead.id, note: "No" });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadNextAction, PROSPECT_REVIEW_NEXT.review);
  });
});

describe("Qualification onward is untouched", () => {
  test("confirming does not answer the Qualification questions or review them", async () => {
    const lead = await prospect();
    await confirmProspectReview({ customerId: lead.id });
    const after = await row(lead.id);
    assert.equal(after.leadStage, "qualification");
    assert.equal(after.leadQualificationReview, null);
  });
});

describe("the Verify call cannot get past what the review enforces", () => {
  test("a lead.verify holder who is not the designated verifier cannot verify by a call", async () => {
    const lead = await prospect();
    setTestUser(otherMgr);
    const r = await recordLeadValidationCall(lead.id, { answers: { current_product: "Asian Paints PU" }, outcome: "verified" });
    assert.equal(r.ok, false);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect");
    assert.equal(after.leadVerifiedAt, null);
  });

  test("the Sales Manager Verify dialog is refused for the same person", async () => {
    const lead = await prospect();
    setTestUser(otherMgr);
    const r = await verifyProspect({
      customerId: lead.id, outcome: "verified", answers: { current_product: "Asian Paints PU" }, corrections: [], expectCorrections: false,
    } as never);
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadVerifiedAt, null);
  });

  test("a call cannot verify while required Prospect answers are missing", async () => {
    const lead = await prospect({ gstin: null, leadCompetitor: null });
    const r = await recordLeadValidationCall(lead.id, { answers: { current_product: "Asian Paints PU" }, outcome: "verified" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Not ready to verify/);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect");
    assert.equal(after.leadVerifiedAt, null);
  });

  test("the designated verifier can still verify by a call", async () => {
    const lead = await prospect();
    setTestUser(mgr);
    const r = await recordLeadValidationCall(lead.id, { answers: { current_product: "Asian Paints PU" }, outcome: "verified" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadStage, "qualification");
  });
});

describe("what the shop is using now is required to verify, and only to verify", () => {
  test("a call that verifies is refused without it, and nothing is recorded", async () => {
    const lead = await prospect();
    setTestUser(mgr);
    const r = await recordLeadValidationCall(lead.id, { answers: {}, outcome: "verified" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "validation");
      assert.match(r.error, /what the shop is using now/i);
    }
    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect");
    assert.equal(after.leadVerifiedAt, null);
    const calls = await db.select().from(mbosLeadValidations).where(eq(mbosLeadValidations.customerId, lead.id));
    assert.equal(calls.length, 0);
  });

  test("a blank or whitespace-only answer is not an answer", async () => {
    const lead = await prospect();
    setTestUser(mgr);
    const r = await recordLeadValidationCall(lead.id, { answers: { current_product: "   " }, outcome: "verified" });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadVerifiedAt, null);
  });

  test("with it, the call verifies and the answer is stored", async () => {
    const lead = await prospect();
    setTestUser(mgr);
    const r = await recordLeadValidationCall(lead.id, { answers: { current_product: "Asian Paints PU" }, outcome: "verified" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadStage, "qualification");
    const [call] = await db.select().from(mbosLeadValidations).where(eq(mbosLeadValidations.customerId, lead.id));
    assert.equal(call.currentProduct, "Asian Paints PU");
  });

  test("Verified-with-corrections (the desk) is held to it too", async () => {
    const lead = await prospect();
    setTestUser(mgr);
    const refused = await verifyProspect({
      customerId: lead.id, outcome: "verified", answers: {}, corrections: [], expectCorrections: false,
    } as never);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.error, /what the shop is using now/i);
    assert.equal((await row(lead.id)).leadVerifiedAt, null);
    const ok = await verifyProspect({
      customerId: lead.id, outcome: "verified", answers: { current_product: "Asian Paints PU" }, corrections: [], expectCorrections: false,
    } as never);
    assert.equal(ok.ok, true, ok.ok ? "" : ok.error);
  });

  test("a follow-up is not asked for it", async () => {
    const lead = await prospect();
    setTestUser(mgr);
    const r = await recordLeadValidationCall(lead.id, {
      answers: {}, outcome: "follow_up", followUpNote: "The buyer was not on the call.",
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadStage, "prospect");
  });

  test("a failed verification is not asked for it either", async () => {
    const lead = await prospect();
    setTestUser(mgr);
    const r = await recordLeadValidationCall(lead.id, {
      answers: {}, outcome: "not_qualified", followUpNote: "The shop denies any enquiry.", failureReasonCode: "denies_enquiry",
    });
    assert.ok(!(!r.ok && /what the shop is using now/i.test(r.error)), "Q14 must not be demanded of a failed verification");
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });
});
