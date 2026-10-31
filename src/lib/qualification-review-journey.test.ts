import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, appModuleAccess, auditLog, customers, leadStageTransitions, notifications, products, timelineEvents, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { resubmitForReview, reviewLeadQualification } from "@/lib/actions/lead-qualification-review";
import { saveQualificationReviewEdits } from "@/lib/actions/lead-qualification-review-edit";
import { saveProspectFields } from "@/lib/actions/leads";
import { loadQualificationReview } from "@/lib/services/lead-qualification-review-service";
import { QUAL_NEXT, settleQualificationState } from "@/lib/services/lead-qualification-flow-service";
import { designatedQualificationApprover } from "@/lib/services/qualification-approver";
import { QUALIFICATION_ANSWERS } from "@/lib/qualification-fixtures";
import { REVIEW_EDIT_ACTION } from "@/lib/qualification-review";
import { DESK_FIELDS } from "@/lib/engines/lead-calling-desk";
import { PROSPECT_CONDITIONS, QUALIFICATION_CONDITIONS } from "@/lib/engines/lead-gates";
import { testPhone } from "@/lib/test-phone";

/* ---------------------------------------------------------------------------
 * The Qualification Review, end to end against the real services.
 *
 * The cast: a Salesman who owns the lead and collected its Qualification, the
 * DESIGNATED approver (the lead manager seat, where no Sales Manager is seated),
 * ANOTHER manager who also holds `lead.verify` and can see the lead, an
 * administrator, and a stranger. A second arrangement seats a Sales Manager on
 * the lead, which makes THEM the designated approver and moves the restriction
 * the CRM puts on a Sales Manager: she reviews, she does not collect.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const DAY = "2026-09-29";

let owner: typeof users.$inferSelect;
let approver: typeof users.$inferSelect;
let otherMgr: typeof users.$inferSelect;
let admin: typeof users.$inferSelect;
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

/** A lead at Qualification with every one of the eight questions answered. */
async function answeredLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
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
  /* The reason it was made a Prospect is history the gate reads from the
     transitions, not a column — without it that Prospect question is unmet. */
  await db.insert(leadStageTransitions).values({
    id: id("lst"), customerId: row.id, fromStage: "suspect", toStage: "prospect", salesType: "direct",
    reasonCode: "high_consumption", actorId: owner.id,
  });
  return row;
}

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const auditFor = (leadId: string, action: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.entityId, leadId), eq(auditLog.action, action)));

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
  admin = await makeUser("Asha Admin", "admin");
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

/* ================================================================ WHO MAY DECIDE */

describe("only the DESIGNATED approver may confirm or reject", () => {
  test("the designated approver confirms", async () => {
    const lead = await answeredLead();
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadQualificationReview, "verified");
  });

  for (const verdict of ["verified", "incomplete", "clarification"] as const) {
    test(`another manager holding lead.verify cannot ${verdict === "verified" ? "confirm" : `reject (${verdict})`}`, async () => {
      const lead = await answeredLead();
      setTestUser(otherMgr);
      const r = await reviewLeadQualification({ customerId: lead.id, verdict, note: "x" });
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, /Only Vikas Verifier can confirm or reject/);
      assert.equal((await row(lead.id)).leadQualificationReview, null, "nothing was recorded");
    });
  }

  test("an administrator is refused — holding every permission is not being the approver", async () => {
    const lead = await answeredLead();
    setTestUser(admin);
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadQualificationReview, null);
  });

  test("the owner and a stranger are refused", async () => {
    const lead = await answeredLead();
    for (const u of [owner, stranger]) {
      setTestUser(u);
      assert.equal((await reviewLeadQualification({ customerId: lead.id, verdict: "verified" })).ok, false, u.name);
    }
    assert.equal((await row(lead.id)).leadQualificationReview, null);
  });

  test("an administrator IS the approver when the lead is theirs to review", async () => {
    const lead = await answeredLead({ leadManagerId: admin.id });
    setTestUser(admin);
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  test("with nobody designated, EVERYBODY is refused — no substitute is found", async () => {
    const lead = await answeredLead({ leadManagerId: null });
    for (const u of [approver, otherMgr, admin]) {
      setTestUser(u);
      const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
      assert.equal(r.ok, false, u.name);
    }
    assert.equal(await designatedQualificationApprover(lead.id), null);
  });

  test("a designated approver whose account is closed is nobody", async () => {
    const lead = await answeredLead();
    await db.update(users).set({ active: false }).where(eq(users.id, approver.id));
    assert.equal(await designatedQualificationApprover(lead.id), null);
    assert.equal((await reviewLeadQualification({ customerId: lead.id, verdict: "verified" })).ok, false);
  });

  test("a Sales Manager seated on the lead is the approver, and the lead manager is not", async () => {
    await db.insert(appModuleAccess).values({ id: id("mod"), userId: otherMgr.id, app: "crm", module: "crm.sales-manager" });
    const lead = await answeredLead({ salesManagerId: otherMgr.id });
    assert.equal((await designatedQualificationApprover(lead.id))?.id, otherMgr.id);
    setTestUser(approver); /* the lead manager, holding lead.verify */
    assert.equal((await reviewLeadQualification({ customerId: lead.id, verdict: "verified" })).ok, false);
    setTestUser(otherMgr);
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  test("the person the review is HANDED TO is the person allowed to decide it (pinned to the hand-off)", async () => {
    for (const arrangement of ["leadManager", "salesManagerSeat"] as const) {
      await db.execute(sql`truncate table audit_log, notifications, timeline_events restart identity cascade`);
      if (arrangement === "salesManagerSeat") {
        await db.insert(appModuleAccess).values({ id: id("mod"), userId: otherMgr.id, app: "crm", module: "crm.sales-manager" });
      }
      const lead = await answeredLead({
        leadNextAction: QUAL_NEXT.complete,
        leadNextActionOwnerId: owner.id,
        ...(arrangement === "salesManagerSeat" ? { salesManagerId: otherMgr.id } : {}),
      });
      await settleQualificationState(lead.id, owner.id, {});
      const handedTo = (await row(lead.id)).leadNextActionOwnerId;
      assert.equal(handedTo, (await designatedQualificationApprover(lead.id))?.id, arrangement);
    }
  });
});

/* ================================================================ CONFIRM / REJECT */

describe("confirm needs the required answers; reject needs a reason", () => {
  test("Confirm is refused while the gate still names something missing", async () => {
    const lead = await answeredLead({ leadQualification: {} });
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Not ready to verify/);
    assert.equal((await row(lead.id)).leadQualificationReview, null);
  });

  test("Reject without a reason is refused; with one it is recorded", async () => {
    const lead = await answeredLead();
    assert.equal((await reviewLeadQualification({ customerId: lead.id, verdict: "incomplete" })).ok, false);
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "incomplete", note: "Confirm the credit days." });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  test("Reject is allowed even while answers are missing", async () => {
    const lead = await answeredLead({ leadQualification: {} });
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "clarification", note: "Which buyer?" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  test("rejecting keeps every answer and the owner, and hands it back with the reason", async () => {
    const lead = await answeredLead();
    const before = await row(lead.id);
    await reviewLeadQualification({ customerId: lead.id, verdict: "incomplete", note: "Confirm the credit days." });
    const after = await row(lead.id);
    assert.equal(after.leadQualificationReview, "incomplete");
    assert.equal(after.leadQualificationReviewNote, "Confirm the credit days.");
    assert.equal(after.leadQualificationReviewedById, approver.id);
    for (const k of ["gstin", "leadApplication", "leadCreditDaysWanted", "leadBuyer", "leadCompetitor", "leadMonthlyVolumeLitres", "leadQualification"] as const) {
      assert.deepEqual(after[k], before[k], k);
    }
    assert.equal(after.ownerId, owner.id);
    assert.equal(after.leadStage, "qualification");
    assert.equal(after.leadNextAction, QUAL_NEXT.answer);
    assert.equal(after.leadNextActionOwnerId, owner.id);
    const told = await db.select().from(notifications).where(eq(notifications.userId, owner.id));
    assert.ok(told.some((n) => /Confirm the credit days/.test(n.body)), "the owner is told the reason");
  });

  test("the rejection is in the audit log with who, the verdict and the reason", async () => {
    const lead = await answeredLead();
    await reviewLeadQualification({ customerId: lead.id, verdict: "incomplete", note: "Ask about credit." });
    const [a] = await auditFor(lead.id, "lead.qualificationReview");
    assert.equal(a.actorId, approver.id);
    assert.equal((a.afterState as Record<string, unknown>).leadQualificationReviewNote, "Ask about credit.");
  });

  test("after a rejection the existing correction and resubmission flow still works", async () => {
    const lead = await answeredLead();
    await reviewLeadQualification({ customerId: lead.id, verdict: "clarification", note: "Which buyer?" });
    setTestUser(owner);
    const r = await resubmitForReview(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    setTestUser(approver);
    assert.equal((await reviewLeadQualification({ customerId: lead.id, verdict: "verified" })).ok, true);
  });
});

/* ================================================================ EDITING */

describe("the approver edits answers through the existing validated writers", () => {
  test("Suspect, Prospect and Qualification answers change, and each change is audited field by field", async () => {
    const lead = await answeredLead();
    const r = await saveQualificationReviewEdits({
      customerId: lead.id,
      edits: { fields: { competitor: "Asian Paints", monthlyLitres: 450, application: "Metal coating" }, answers: { price_range: "₹200 / L" } },
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    if (r.ok) assert.equal(r.data.changed, 4);
    const after = await row(lead.id);
    assert.equal(after.leadCompetitor, "Asian Paints");
    assert.equal(after.leadApplication, "Metal coating");
    assert.equal((after.leadQualification as Record<string, unknown>).price_range, "₹200 / L");

    const [a] = await auditFor(lead.id, REVIEW_EDIT_ACTION);
    assert.equal(a.actorId, approver.id);
    assert.ok(a.at);
    const byField = Object.fromEntries(
      (a.afterState as { changes: { field: string; from: unknown; to: unknown }[] }).changes.map((c) => [c.field, c]),
    );
    assert.deepEqual([byField.competitor.from, byField.competitor.to], ["Local thinner", "Asian Paints"]);
    assert.equal(byField.price_range.to, "₹200 / L");
  });

  test("a changed GST number is masked in the audit; the timeline carries names, never values", async () => {
    const lead = await answeredLead();
    const r = await saveQualificationReviewEdits({ customerId: lead.id, edits: { fields: { gstin: "29ZZZZZ9999Z1Z1", buyer: "Mr Rao" } } });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const dump = JSON.stringify((await auditFor(lead.id, REVIEW_EDIT_ACTION))[0]);
    assert.ok(!dump.includes("29ZZZZZ9999Z1Z1") && !dump.includes("ABCDE1234"));
    const summary = (await db.select().from(timelineEvents).where(eq(timelineEvents.customerId, lead.id))).map((t) => t.summary).join("\n");
    assert.match(summary, /GST/);
    assert.ok(!summary.includes("Mr Rao"));
  });

  test("the creator, owner and the lead's place are untouched by an edit", async () => {
    const lead = await answeredLead();
    const before = await row(lead.id);
    await saveQualificationReviewEdits({ customerId: lead.id, edits: { fields: { contactPerson: "Ramesh" } } });
    const after = await row(lead.id);
    assert.equal(after.contactPerson, "Ramesh");
    for (const k of ["ownerId", "leadManagerId", "salesManagerId", "leadStage", "leadSalesType", "kind", "leadNextAction"] as const) {
      assert.equal(after[k], before[k], k);
    }
  });

  test("the existing validation still governs: an out-of-range credit period is refused and nothing is audited", async () => {
    const lead = await answeredLead();
    const r = await saveQualificationReviewEdits({ customerId: lead.id, edits: { fields: { creditDaysWanted: -5 } } });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadCreditDaysWanted, 30);
    assert.equal((await auditFor(lead.id, REVIEW_EDIT_ACTION)).length, 0);
  });

  test("saving the same values changes nothing and files no edit", async () => {
    const lead = await answeredLead();
    const r = await saveQualificationReviewEdits({ customerId: lead.id, edits: { fields: { competitor: "Local thinner" } } });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.data.changed, 0);
    assert.equal((await auditFor(lead.id, REVIEW_EDIT_ACTION)).length, 0);
  });

  test("names the review does not edit refuse the WHOLE request", async () => {
    const lead = await answeredLead();
    const before = await row(lead.id);
    for (const edits of [
      { fields: { competitor: "Changed", leadStage: "won" } },
      { fields: { ownerId: stranger.id } },
      { fields: { leadQualificationReview: "verified" } },
      { answers: { gst_verified: "yes" } },
      { verdict: "verified" },
    ]) {
      assert.equal((await saveQualificationReviewEdits({ customerId: lead.id, edits: edits as never })).ok, false, JSON.stringify(edits));
    }
    const after = await row(lead.id);
    assert.equal(after.leadCompetitor, before.leadCompetitor);
    assert.equal(after.leadStage, "qualification");
    assert.equal(after.leadQualificationReview, null);
  });

  test("an edit does not confirm anything, and is closed once the lead is past Qualification", async () => {
    const lead = await answeredLead();
    await saveQualificationReviewEdits({ customerId: lead.id, edits: { fields: { competitor: "Asian Paints" } } });
    assert.equal((await row(lead.id)).leadQualificationReview, null);
    const later = await answeredLead({ leadStage: "sample_trial" });
    assert.equal((await saveQualificationReviewEdits({ customerId: later.id, edits: { fields: { competitor: "x" } } })).ok, false);
  });
});

describe("the CRM's own division of labour: a Sales Manager reviews, the Salesman collects", () => {
  async function seatedLead() {
    await db.insert(appModuleAccess).values({ id: id("mod"), userId: otherMgr.id, app: "crm", module: "crm.sales-manager" });
    setTestUser(otherMgr);
    return answeredLead({ salesManagerId: otherMgr.id });
  }

  test("the seated Sales Manager approver CAN edit Suspect and Prospect answers", async () => {
    const lead = await seatedLead();
    const r = await saveQualificationReviewEdits({ customerId: lead.id, edits: { fields: { competitor: "Asian Paints", monthlyLitres: 500 } } });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadCompetitor, "Asian Paints");
  });

  test("…but NOT the Qualification-only answers: refused with the CRM's sentence, nothing saved", async () => {
    const lead = await seatedLead();
    for (const edits of [{ fields: { application: "x" } }, { fields: { gstin: "29ZZZZZ9999Z1Z1" } }, { answers: { price_range: "y" } }]) {
      const r = await saveQualificationReviewEdits({ customerId: lead.id, edits: edits as never });
      assert.equal(r.ok, false, JSON.stringify(edits));
      if (!r.ok) assert.match(r.error, /Salesman who owns this lead completes its Qualification/);
    }
    const after = await row(lead.id);
    assert.equal(after.leadApplication, "Wood polish");
    assert.equal(after.gstin, "27ABCDE1234F1Z5");
  });

  test("a mixed request saves NEITHER half", async () => {
    const lead = await seatedLead();
    const r = await saveQualificationReviewEdits({ customerId: lead.id, edits: { fields: { competitor: "Asian Paints", application: "x" } } });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadCompetitor, "Local thinner");
    assert.equal((await auditFor(lead.id, REVIEW_EDIT_ACTION)).length, 0);
  });

  test("the review draws those answers READ ONLY, with the reason", async () => {
    const lead = await seatedLead();
    const m = (await loadQualificationReview(lead.id, otherMgr))!;
    assert.equal(m.viewer.canDecide, true);
    const f = m.rows.find((r) => r.key === "qualification:price_and_credit")!.fields.find((x) => x.id === "price_range")!;
    assert.equal(f.editKey, null);
    assert.match(f.readOnlyReason ?? "", /Salesman who owns this lead completes its Qualification/);
    assert.equal(m.rows.find((r) => r.key === "suspect:competitor")!.fields[0].editKey, "competitor");
  });
});

describe("nobody else can edit from the review", () => {
  for (const [label, who] of [
    ["another manager with lead.verify", () => otherMgr],
    ["an administrator", () => admin],
    ["the owning Salesman", () => owner],
    ["a stranger", () => stranger],
  ] as const) {
    test(`${label} is refused, and nothing is written or audited`, async () => {
      const lead = await answeredLead();
      setTestUser(who());
      const r = await saveQualificationReviewEdits({ customerId: lead.id, edits: { fields: { competitor: "Hijacked" } } });
      assert.equal(r.ok, false);
      if (!r.ok && who() === otherMgr) assert.match(r.error, /Only Vikas Verifier/);
      assert.equal((await row(lead.id)).leadCompetitor, "Local thinner");
      assert.equal((await auditFor(lead.id, REVIEW_EDIT_ACTION)).length, 0);
    });
  }

  test("the Salesman's OWN ordinary writer is unaffected — they still edit their own answers", async () => {
    const lead = await answeredLead();
    setTestUser(owner);
    const r = await saveProspectFields(lead.id, { application: "Salesman's correction" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });
});

/* ================================================================ THE SCREEN'S MODEL */

describe("the review model", () => {
  test("every current question is present with its saved answer", async () => {
    const lead = await answeredLead();
    const m = (await loadQualificationReview(lead.id, approver))!;
    assert.deepEqual(m.rows.filter((r) => r.section === "suspect").map((r) => r.id), DESK_FIELDS.map((f) => f.key));
    assert.deepEqual(m.rows.filter((r) => r.section === "prospect").map((r) => r.id), PROSPECT_CONDITIONS.map((c) => c.id));
    assert.deepEqual(m.rows.filter((r) => r.section === "qualification").map((r) => r.id), QUALIFICATION_CONDITIONS.map((c) => c.id));
    const f = (k: string, id: string) => m.rows.find((r) => r.key === k)!.fields.find((x) => x.id === id)!;
    assert.equal(f("suspect:monthlyLitres", "monthlyLitres").display, "300 Litres");
    assert.equal(f("suspect:competitor", "competitor").display, "Local thinner");
    assert.equal(f("suspect:requiredProductId", "requiredProductId").display, "PU Thinner - 20 Liter (Loose)");
  });

  test("a complete lead reads complete by the gate, and is waiting for the approver", async () => {
    const lead = await answeredLead();
    const m = (await loadQualificationReview(lead.id, approver))!;
    assert.deepEqual(m.blockers, []);
    assert.equal(m.tally.missingRequired, 0);
    assert.equal(m.state, "pending");
  });

  test("missing answers are flagged, and the gate's own words say what holds Confirm", async () => {
    const lead = await answeredLead({ leadQualification: {}, leadCompetitor: null });
    const m = (await loadQualificationReview(lead.id, approver))!;
    assert.equal(m.rows.find((r) => r.key === "suspect:competitor")!.answered, false);
    assert.ok(m.tally.missingRequired >= 2);
    assert.ok(m.blockers.length >= 1);
    assert.equal(m.state, "in_progress");
  });

  test("only the designated approver gets editable boxes and the decision", async () => {
    const lead = await answeredLead();
    const m = (await loadQualificationReview(lead.id, approver))!;
    assert.equal(m.viewer.canDecide, true);
    assert.ok(m.rows.some((r) => r.fields.some((f) => f.editKey)));
    assert.equal(m.people.ownerName, "Sonu Salesman");
    assert.equal(m.people.verifierName, "Vikas Verifier");
  });

  test("another manager, an admin and the owner see the same answers and NO edit control", async () => {
    const lead = await answeredLead();
    for (const u of [otherMgr, owner, admin]) {
      const m = (await loadQualificationReview(lead.id, u))!;
      assert.ok(m, u.name);
      assert.equal(m.viewer.canDecide, false, u.name);
      assert.equal(m.rows.flatMap((r) => r.fields).filter((f) => f.editKey).length, 0, u.name);
      assert.equal(m.rows.length, DESK_FIELDS.length + PROSPECT_CONDITIONS.length + QUALIFICATION_CONDITIONS.length);
    }
  });

  test("the owner sees the decision and the rejection reason", async () => {
    const lead = await answeredLead();
    await reviewLeadQualification({ customerId: lead.id, verdict: "incomplete", note: "Confirm the credit days." });
    const m = (await loadQualificationReview(lead.id, owner))!;
    assert.equal(m.state, "sent_back");
    assert.equal(m.decision?.verdict, "incomplete");
    assert.equal(m.decision?.note, "Confirm the credit days.");
    assert.equal(m.decision?.byName, "Vikas Verifier");
    assert.ok(m.history.some((h) => h.kind === "incomplete" && h.note === "Confirm the credit days."));
  });

  test("history lists edits with who, when and before/after, newest first", async () => {
    const lead = await answeredLead();
    await saveQualificationReviewEdits({ customerId: lead.id, edits: { fields: { competitor: "Asian Paints" } } });
    await reviewLeadQualification({ customerId: lead.id, verdict: "clarification", note: "Which buyer?" });
    const m = (await loadQualificationReview(lead.id, owner))!;
    assert.deepEqual(m.history.map((h) => h.kind), ["clarification", "edit"]);
    const edit = m.history.find((h) => h.kind === "edit")!;
    assert.equal(edit.byName, "Vikas Verifier");
    assert.deepEqual([edit.changes[0].from, edit.changes[0].to], ["Local thinner", "Asian Paints"]);
  });

  test("a lead that does not exist gives nothing", async () => {
    assert.equal(await loadQualificationReview("cus_missing", approver), null);
  });
});
