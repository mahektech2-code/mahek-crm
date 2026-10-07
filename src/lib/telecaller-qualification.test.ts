import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  auditLog,
  customerDistributors,
  customers,
  mbosApprovals,
  mbosDevices,
  mbosSamples,
  mbosTasks,
  mbosUserTerritories,
  notifications,
  products,
  timelineEvents,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { captureLead } from "@/lib/actions/lead-intake";
import { assignDeskLead, bulkAssignDeskLeads } from "@/lib/actions/lead-desk-assignment";
import { convertLeadToProspect, logQualificationCall } from "@/lib/actions/lead-calling-desk";
import {
  recordLeadValidationCall,
  saveLeadQualification,
  saveProspectFields,
  setLeadNextAction,
  setLeadSalesType,
} from "@/lib/actions/leads";
import { verifyProspect } from "@/lib/actions/sales-manager-pipeline";
import { resubmitForReview, reviewLeadQualification } from "@/lib/actions/lead-qualification-review";
import { validateGstin } from "@/lib/actions/lead-gst";
import { QUALIFICATION_ANSWERS } from "@/lib/qualification-fixtures";
import { confirmLeadFigures } from "@/lib/actions/lead-figures";
import { nameLeadDistributor } from "@/lib/actions/lead-distributor-link";
import { addDistributor } from "@/lib/actions/third-party";
import { decideSample, requestSample } from "@/lib/actions/lead-samples";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { leadRecord } from "@/lib/services/lead-console-service";
import {
  leadGateInput,
  leadManagerCandidates,
  leadRow,
} from "@/lib/services/lead-service";
import { QUAL_NEXT, sampleEligibility } from "@/lib/services/lead-qualification-flow-service";
import { qualificationComplete, qualificationReadyForReview, gateTo } from "@/lib/engines/lead-gates";
import type { MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";

/* ---------------------------------------------------------------------------
 * THE TELECALLER-OWNED QUALIFICATION WORKFLOW, end to end.
 *
 *   Suspect → Telecaller Calling Desk → Prospect → Sales Manager verification
 *   → Qualification by the Telecaller → Sales Manager review → Sample / Trial
 *
 * There is no Salesman in it. Every rule the plan locked has a test here, and
 * every one runs the real actions against the real database — a rule pinned
 * only in an engine is a rule nobody has watched hold at the door.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const DAY = "2026-09-29";

let tele: typeof users.$inferSelect;
let tele2: typeof users.$inferSelect;
let mgr: typeof users.$inferSelect;
let acctMgr: typeof users.$inferSelect;
let fieldUser: typeof users.$inferSelect;
let productId: string;
let distributorId: string;

async function makeUser(
  name: string,
  role: "associate" | "manager",
  app: "crm" | "accounts" | "field" = "crm",
) {
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
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role });
  return row;
}

/**
 * The lead record is a `managerScope` read, and a test names no app on its
 * request — so the reader's level is asked on the Sales Dashboard. A CRM
 * manager with no Sales grant is narrowed to their own book there (it used to
 * answer national for anybody without a region row, the fail-open the scope no
 * longer has), so the manager reading another person's lead holds Sales too.
 */
async function readsLeadsAsManager(userId: string) {
  await db.insert(appAccess).values({ id: id("aca"), userId, app: "sales", role: "manager" });
}

/** The Calling desk is a module of its own, granted to a person. */
async function grantDesk(userId: string) {
  await db
    .insert(appModuleAccess)
    .values({ id: id("mod"), userId, app: "crm", module: "crm.lead-calling-desk" });
}

async function makeLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      contactPerson: "Ganesh",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nashik",
      kind: "lead",
      leadStage: "suspect",
      leadSalesType: "direct",
      leadSource: "manual",
      ownerId: tele.id,
      leadManagerId: mgr.id,
      ...over,
    })
    .returning();
  return row;
}

/** A Prospect the desk has already promoted: unverified, verification owed by the manager. */
const prospect = (over: Partial<typeof customers.$inferInsert> = {}) =>
  makeLead({
    leadStage: "prospect",
    customerType: "retailer",
    leadMonthlyVolumeLitres: 300,
    leadEstimatedPotentialPaise: 9_000_000,
    leadCompetitor: "Local thinner",
    leadRequiredProductId: productId,
    leadDecisionMaker: "Owner",
    leadNextAction: QUAL_NEXT.verify,
    leadNextActionDate: DAY,
    leadNextActionOwnerId: mgr.id,
    ...over,
  });

/** A lead standing at Qualification with NOTHING answered yet, verified by the manager. */
const atQualification = (over: Partial<typeof customers.$inferInsert> = {}) =>
  prospect({
    leadStage: "qualification",
    leadVerifiedAt: new Date(),
    leadVerifiedById: mgr.id,
    leadNextAction: QUAL_NEXT.complete,
    leadNextActionOwnerId: tele.id,
    ...over,
  });

/** Everything the Telecaller owns is answered; the manager has not reviewed. */
const answered = (over: Partial<typeof customers.$inferInsert> = {}) =>
  atQualification({
    gstin: "27ABCDE1234F1Z5",
    /* The Sales Manager validates the GST number: here, the manager. */
    gstVerified: true,
    gstVerifiedAt: new Date(),
    gstVerifiedById: mgr.id,
    leadApplication: "Wood polish",
    leadCreditDaysWanted: 30,
    leadBuyer: "Ganesh's brother",
    leadFiguresConfirmedAt: new Date(),
    /* All eight answered: the four columns above and these stored answers. */
    leadQualification: { ...QUALIFICATION_ANSWERS },
    ...over,
  });

/** …and the manager has verified it. */
const reviewed = (over: Partial<typeof customers.$inferInsert> = {}) =>
  answered({
    leadQualificationReview: "verified",
    leadQualificationReviewNote: "Reads well.",
    leadQualificationReviewedAt: new Date(),
    leadQualificationReviewedById: mgr.id,
    ...over,
  });

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];

const CAPTURE = () => ({
  name: `Shop ${randomUUID().slice(0, 6)}`,
  phone: String(9100000000 + Math.floor(Math.random() * 99999999)),
  city: "Nagpur",
  source: "telecalling",
});

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
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
  tele = await makeUser("Tara Telecaller", "associate");
  tele2 = await makeUser("Tina Telecaller", "associate");
  mgr = await makeUser("Manoj Manager", "manager");
  acctMgr = await makeUser("Anil Accounts", "manager", "accounts");
  fieldUser = await makeUser("Farid Field", "associate", "field");
  for (const u of [tele, tele2, mgr]) await grantDesk(u.id);
  /* A manager sees a lead through the people who report to them (or a seat on
     the lead). The Telecallers report to the Sales Manager, as they do in life. */
  await db.update(users).set({ reportsToId: mgr.id }).where(sql`id in (${tele.id}, ${tele2.id})`);
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
  const [d] = await db
    .insert(customers)
    .values({ id: id("cus"), name: "Bharat Distributors", phone: "9000000001", city: "Pune", kind: "customer" })
    .returning();
  distributorId = d.id;
  setTestUser(tele);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ============================================================== OWNERSHIP */

describe("the creator is the initial owner, and Created By never moves", () => {
  test("a Telecaller who captures a lead owns it, and the creation history names them", async () => {
    setTestUser(tele);
    const r = await captureLead(CAPTURE());
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    if (!r.ok) return;
    assert.equal((await row(r.data.customerId)).ownerId, tele.id);

    const created = await db
      .select()
      .from(timelineEvents)
      .where(and(eq(timelineEvents.customerId, r.data.customerId), eq(timelineEvents.eventType, "lead_created")));
    assert.equal(created.length, 1);
    assert.equal(created[0].actorUserId, tele.id);
    setTestUser(mgr);
    await readsLeadsAsManager(mgr.id);
    assert.equal((await leadRecord(r.data.customerId, DAY))?.createdByName, "Tara Telecaller");
  });

  test("a manager's capture stays unassigned — raising a lead is handing it to the desk", async () => {
    setTestUser(mgr);
    const r = await captureLead(CAPTURE());
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    if (!r.ok) return;
    assert.equal((await row(r.data.customerId)).ownerId, null);
  });

  test("somebody with no desk stays unassigned; a named owner and an explicit null are both respected", async () => {
    setTestUser(fieldUser);
    const none = await captureLead(CAPTURE());
    // The field app does not hold lead.work — the point is the owner, not the door.
    if (none.ok) assert.equal((await row(none.data.customerId)).ownerId, null);

    setTestUser(tele);
    const explicitNull = await captureLead({ ...CAPTURE(), ownerId: null });
    assert.equal(explicitNull.ok && (await row(explicitNull.data.customerId)).ownerId, null);

    setTestUser(mgr);
    const named = await captureLead({ ...CAPTURE(), ownerId: tele2.id });
    assert.equal(named.ok && (await row(named.data.customerId)).ownerId, tele2.id);
  });
});

describe("reassignment changes the owner and nothing about who raised the lead", () => {
  test("the manager reassigns; owner changes, creator and history stay", async () => {
    setTestUser(tele);
    const made = await captureLead({ ...CAPTURE(), salesType: "direct" });
    assert.ok(made.ok);
    const leadId = made.ok ? made.data.customerId : "";

    setTestUser(mgr);
    const r = await assignDeskLead({ customerId: leadId, ownerId: tele2.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(leadId)).ownerId, tele2.id);

    await readsLeadsAsManager(mgr.id);
    assert.equal((await leadRecord(leadId, DAY))?.createdByName, "Tara Telecaller", "the creator does not change");
    const moves = await db
      .select()
      .from(timelineEvents)
      .where(and(eq(timelineEvents.customerId, leadId), eq(timelineEvents.eventType, "owner_change")));
    assert.ok(moves.length >= 1, "the reassignment is in the history");
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.entityId, leadId), eq(auditLog.action, "lead.reassigned")));
    assert.equal(audit.length, 1);
  });

  test("an unauthorised reassignment is refused and changes nothing", async () => {
    const lead = await makeLead();
    setTestUser(tele);
    const r = await assignDeskLead({ customerId: lead.id, ownerId: tele2.id });
    assert.equal(r.ok, false);
    setTestUser(tele2);
    const bulk = await bulkAssignDeskLeads({ leadIds: [lead.id], ownerId: tele2.id });
    assert.equal(bulk.ok, false);
    assert.equal((await row(lead.id)).ownerId, tele.id);
  });

  test("a lead can only go to somebody who holds the desk — and never to a field-app picker", async () => {
    const lead = await makeLead();
    setTestUser(mgr);
    const r = await assignDeskLead({ customerId: lead.id, ownerId: fieldUser.id });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).ownerId, tele.id);
  });

  test("a next action owed by the old owner follows; the manager's verification does not", async () => {
    const mine = await makeLead({
      leadNextAction: QUAL_NEXT.complete,
      leadNextActionDate: DAY,
      leadNextActionOwnerId: tele.id,
    });
    const verification = await prospect();
    setTestUser(mgr);
    assert.equal((await assignDeskLead({ customerId: mine.id, ownerId: tele2.id })).ok, true);
    assert.equal((await assignDeskLead({ customerId: verification.id, ownerId: tele2.id })).ok, true);

    assert.equal((await row(mine.id)).leadNextActionOwnerId, tele2.id, "the Telecaller's own job moved with the lead");
    const v = await row(verification.id);
    assert.equal(v.ownerId, tele2.id);
    assert.equal(v.leadNextActionOwnerId, mgr.id, "the manager's verification stayed the manager's");
  });

  test("a bulk change moves each lead by the same rules and names what did not move", async () => {
    const a = await makeLead();
    const b = await makeLead({ ownerId: tele2.id });
    setTestUser(mgr);
    const r = await bulkAssignDeskLeads({ leadIds: [a.id, b.id], ownerId: tele2.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal(r.ok && r.data.done, 1);
    assert.deepEqual(r.ok && r.data.failed.map((f) => f.why), ["already theirs"]);
  });
});

/* ============================================================== PROSPECT */

describe("Suspect → Prospect: the Telecaller promotes, the Sales Manager verifies", () => {
  const promote = async (over: Partial<typeof customers.$inferInsert> = {}) => {
    const lead = await makeLead(over);
    setTestUser(tele);
    const call = await logQualificationCall({
      customerId: lead.id,
      outcome: "spoke_collected",
      answers: {
        monthlyLitres: 200,
        requiredProductId: productId,
        competitor: "Local thinner",
        decisionMaker: "Owner",
      },
    });
    assert.equal(call.ok && call.data.result, "ready", call.ok ? "" : call.error);
    return lead;
  };
  const convert = (customerId: string) =>
    convertLeadToProspect({ customerId, reasonCode: "regular_requirement", customerType: "manufacturer" });

  test("the promotion is unverified, the owner is untouched, and the verification is the manager's", async () => {
    const lead = await promote();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.match(r.ok ? (r.message ?? "") : "", /Waiting for Sales Manager verification/);

    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect");
    assert.equal(after.leadVerifiedAt, null);
    assert.equal(after.ownerId, tele.id, "the manager does not become the owner");
    assert.equal(after.leadNextAction, QUAL_NEXT.verify);
    assert.equal(after.leadNextActionOwnerId, mgr.id);
    assert.notEqual(after.leadNextActionOwnerId, tele.id, "never the Telecaller's");
  });

  test("with nobody to verify it, the conversion is refused and the lead stays a Suspect", async () => {
    // The only manager covers Kerala; the lead is in Maharashtra. The accounts manager
    // is a manager by level but cannot verify a lead.
    await db.insert(mbosUserTerritories).values({ id: id("ut"), userId: mgr.id, kind: "region", region: "Kerala" });
    const lead = await promote({ leadManagerId: null, territoryRegion: "Maharashtra" });
    const r = await convert(lead.id);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /No Sales Manager covers this lead's region./);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "suspect");
    assert.equal(after.leadNextActionOwnerId === tele.id && after.leadNextAction === QUAL_NEXT.verify, false);
  });

  test("manager candidates are holders of lead.verify — an accounts-only manager is not one", async () => {
    const names = (await leadManagerCandidates(null)).map((c) => c.name);
    assert.ok(names.includes("Manoj Manager"));
    assert.equal(names.includes(acctMgr.name), false);
  });
});

/* ========================================================== VERIFICATION */

describe("a successful verification opens Qualification, on every door", () => {
  test("the console's verification call", async () => {
    const lead = await prospect();
    setTestUser(mgr);
    const r = await recordLeadValidationCall(lead.id, { answers: {}, outcome: "verified" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "qualification");
    assert.ok(after.leadVerifiedAt);
    assert.equal(after.ownerId, tele.id, "verifying does not change the owner");
    assert.equal(after.leadNextAction, QUAL_NEXT.complete);
    assert.equal(after.leadNextActionOwnerId, tele.id);

    const told = await db.select().from(notifications).where(eq(notifications.userId, tele.id));
    assert.ok(
      told.some((n) => /Verified by Manoj Manager on .+\. Qualification is now ready for you\./.test(n.body)),
      "the Telecaller is told, in the locked words",
    );
  });

  test("the Sales Manager pipeline", async () => {
    const lead = await prospect();
    setTestUser(mgr);
    const r = await verifyProspect({ customerId: lead.id, outcome: "verified", answers: {}, corrections: [] });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadStage, "qualification");
  });

  test("a follow-up or a Telecaller's attempt opens nothing", async () => {
    const lead = await prospect();
    setTestUser(mgr);
    await recordLeadValidationCall(lead.id, { answers: {}, outcome: "follow_up", followUpNote: "Ring the buyer." });
    assert.equal((await row(lead.id)).leadStage, "prospect");

    setTestUser(tele);
    const attempt = await recordLeadValidationCall(lead.id, { answers: {}, outcome: "verified" });
    assert.equal(attempt.ok, false, "a Telecaller cannot verify");
    const after = await row(lead.id);
    assert.equal(after.leadVerifiedAt, null);
    assert.equal(after.leadStage, "prospect");
  });

  test("an unverified Prospect cannot be moved to Qualification by anybody holding lead.work", async () => {
    const lead = await prospect();
    const gate = await leadGateInput(lead.id);
    assert.ok(gate);
    assert.deepEqual(gateTo(gate!, "qualification").missing.map((c) => c.id), ["manager_verified"]);
  });

  describe("the handset", () => {
    let principalFor: (u: typeof users.$inferSelect, role: "associate" | "manager") => MbosPrincipal;
    const item = (customerId: string, verdict: string): SyncItem => {
      const entityId = id("val");
      return {
        queueId: id("q"),
        entityType: "lead_validation",
        entityId,
        op: "create",
        idempotencyKey: `${entityId}:create:${randomUUID()}`,
        clientCreatedAt: Date.now(),
        payload: { customerId, verdict, reached: true, verdictReason: verdict === "confirmed" ? null : "No." },
      } as SyncItem;
    };
    beforeEach(async () => {
      await db.insert(appAccess).values({ id: id("aca"), userId: mgr.id, app: "field", role: "manager" });
      for (const u of [mgr, fieldUser]) {
        await db.insert(mbosDevices).values({ id: id("dev"), userId: u.id, deviceId: `dev-${u.id}`, active: true });
      }
      principalFor = (u, role) =>
        ({
          user: u,
          deviceId: `dev-${u.id}`,
          role,
          scope: { kind: "all" },
        }) as unknown as MbosPrincipal;
    });

    test("verification needs lead.verify — a field user cannot verify his own lead", async () => {
      const lead = await prospect({ ownerId: fieldUser.id });
      const [res] = await ingestSyncBatch(principalFor(fieldUser, "associate"), [item(lead.id, "confirmed")]);
      assert.equal(res.status, "rejected", JSON.stringify(res));
      const after = await row(lead.id);
      assert.equal(after.leadVerifiedAt, null);
      assert.equal(after.leadStage, "prospect");
    });

    test("a manager's confirmation opens Qualification — with no requirement visit and no second validation call", async () => {
      const lead = await prospect();
      const [res] = await ingestSyncBatch(principalFor(mgr, "manager"), [item(lead.id, "confirmed")]);
      assert.equal(res.status, "accepted", JSON.stringify(res));
      const after = await row(lead.id);
      assert.equal(after.leadStage, "qualification");
      assert.equal(after.ownerId, tele.id);
      assert.equal(after.leadNextActionOwnerId, tele.id);
      const tasks = await db.select().from(mbosTasks).where(eq(mbosTasks.customerId, lead.id));
      assert.equal(tasks.filter((t) => t.sourceType === "requirement_visit").length, 0);
      assert.equal(tasks.filter((t) => t.sourceType === "lead_validation").length, 0);
    });
  });
});

/* =========================================================== QUALIFICATION */

describe("Qualification is the Telecaller's, and it exists only after verification", () => {
  test("a Prospect cannot save Qualification answers; its own figures stay writable", async () => {
    const lead = await prospect();
    setTestUser(tele);
    for (const r of [
      await saveLeadQualification(lead.id, { willing_to_test: "yes" }),
      await saveProspectFields(lead.id, { application: "Wood polish" }),
      await saveProspectFields(lead.id, { creditDaysWanted: 30 }),
      await saveProspectFields(lead.id, { buyer: "Brother" }),
      await saveProspectFields(lead.id, { gstin: "27ABCDE1234F1Z5" }),
    ]) {
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.code, "rule_violation");
    }
    assert.equal((await saveProspectFields(lead.id, { monthlyLitres: 400 })).ok, true, "the Prospect's own figures are not Qualification");
    const after = await row(lead.id);
    assert.equal(after.leadApplication, null);
    assert.deepEqual(after.leadQualification, {});
  });

  test("GST, figures and the checklist cannot be answered against a Prospect either", async () => {
    const lead = await prospect({ gstin: "27ABCDE1234F1Z5" });
    setTestUser(tele);
    assert.equal((await validateGstin({ customerId: lead.id, valid: true })).ok, false);
    assert.equal((await confirmLeadFigures({ customerId: lead.id })).ok, false);
  });

  test("the owner completes every condition, and the manager is asked to review — once", async () => {
    const lead = await atQualification();
    setTestUser(tele);
    const steps = [
      await saveProspectFields(lead.id, { gstin: "27ABCDE1234F1Z5", application: "Wood polish", creditDaysWanted: 30, buyer: "Ganesh's brother" }),
      await saveLeadQualification(lead.id, { ...QUALIFICATION_ANSWERS }),
    ];
    for (const s of steps) assert.equal(s.ok, true, s.ok ? "" : s.error);
    // Figures are the last thing outstanding.
    let gate = await leadGateInput(lead.id);
    assert.equal(qualificationReadyForReview(gate!), false);
    assert.ok(gateTo(gate!, "sample_trial").missing.some((c) => c.id === "figures_fresh"));

    assert.equal((await confirmLeadFigures({ customerId: lead.id })).ok, true);
    gate = await leadGateInput(lead.id);
    assert.equal(qualificationReadyForReview(gate!), true, "everything the owner collects is answered");
    assert.equal(qualificationComplete(gate!), false, "the GST validation is still the manager's to make");
    assert.deepEqual(
      gateTo(gate!, "sample_trial").missing.map((c) => c.id).sort(),
      ["gst_verified", "manager_review_pending"],
      "the manager's validation and review stand in the way, and nothing else",
    );

    const after = await row(lead.id);
    assert.equal(after.leadNextAction, QUAL_NEXT.review);
    assert.equal(after.leadNextActionOwnerId, mgr.id);
    // Saving again does not ring him again.
    await saveLeadQualification(lead.id, { willing_to_test: "yes" });
    const bells = await db.select().from(notifications).where(eq(notifications.userId, mgr.id));
    assert.equal(bells.filter((b) => /ready for your review/.test(b.title)).length, 1);

    // The manager validates the number; only his review remains.
    setTestUser(mgr);
    assert.equal((await validateGstin({ customerId: lead.id, valid: true })).ok, true);
    gate = await leadGateInput(lead.id);
    assert.equal(qualificationComplete(gate!), true);
    assert.deepEqual(gateTo(gate!, "sample_trial").missing.map((c) => c.id), ["manager_review_pending"]);
  });

  test("the owner ENTERS the GSTIN; the manager validates it, and the owner cannot", async () => {
    const lead = await atQualification();
    setTestUser(tele);
    assert.equal((await saveProspectFields(lead.id, { gstin: "27ABCDE1234F1Z5" })).ok, true);
    const own = await validateGstin({ customerId: lead.id, valid: true });
    assert.equal(own.ok, false, "a check by the person who entered it is not a check");
    assert.notEqual((await row(lead.id)).gstVerified, true);

    setTestUser(mgr);
    const v = await validateGstin({ customerId: lead.id, valid: true });
    assert.equal(v.ok, true, v.ok ? "" : v.error);
    const after = await row(lead.id);
    assert.equal(after.gstVerified, true);
    assert.equal(after.gstVerifiedById, mgr.id, "the record says which person asserted it");
  });

  test("changing the GSTIN clears the validation; saving the same number does not", async () => {
    const lead = await atQualification({
      gstin: "27ABCDE1234F1Z5",
      gstVerified: true,
      gstVerifiedAt: new Date(),
      gstVerifiedById: tele.id,
    });
    setTestUser(tele);
    await saveProspectFields(lead.id, { gstin: "27ABCDE1234F1Z5" });
    assert.equal((await row(lead.id)).gstVerified, true, "an identical number changes nothing");

    await saveProspectFields(lead.id, { gstin: "29AAAAA0000A1Z5" });
    const after = await row(lead.id);
    assert.equal(after.gstVerified, false);
    assert.equal(after.gstVerifiedAt, null);
    assert.equal(after.gstVerifiedById, null);
  });

  test("nobody outside the Telecaller's book can work it — a field holder cannot touch a Telecaller's Qualification", async () => {
    const lead = await atQualification();
    setTestUser(fieldUser);
    assert.equal((await saveLeadQualification(lead.id, { willing_to_test: "yes" })).ok, false);
    assert.equal((await saveProspectFields(lead.id, { application: "x" })).ok, false);
  });
});

/* ================================================================ REVIEW */

describe("the Sales Manager's review is mandatory", () => {
  const gateOf = async (leadId: string) => gateTo((await leadGateInput(leadId))!, "sample_trial");

  test("no review, incomplete and clarification all block; only verified passes", async () => {
    const lead = await answered();
    assert.deepEqual((await gateOf(lead.id)).missing.map((c) => c.id), ["manager_review_pending"]);

    setTestUser(mgr);
    for (const verdict of ["incomplete", "clarification"] as const) {
      const r = await reviewLeadQualification({ customerId: lead.id, verdict, note: "Ask about credit." });
      assert.equal(r.ok, true, r.ok ? "" : r.error);
      assert.deepEqual((await gateOf(lead.id)).missing.map((c) => c.id), ["manager_review_open"], verdict);
    }
    assert.equal((await reviewLeadQualification({ customerId: lead.id, verdict: "verified" })).ok, true);
    assert.equal((await gateOf(lead.id)).open, true);
  });

  test("a negative verdict needs a note, goes back to the Telecaller with it, and tells them", async () => {
    const lead = await answered();
    setTestUser(mgr);
    const bare = await reviewLeadQualification({ customerId: lead.id, verdict: "incomplete" });
    assert.equal(bare.ok, false, "a refusal with no sentence teaches nothing");

    await reviewLeadQualification({ customerId: lead.id, verdict: "incomplete", note: "Confirm the credit days." });
    const after = await row(lead.id);
    assert.equal(after.leadNextAction, QUAL_NEXT.answer);
    assert.equal(after.leadNextActionOwnerId, tele.id);
    assert.equal(after.leadNextActionOutcome, "Confirm the credit days.");
    const told = await db.select().from(notifications).where(eq(notifications.userId, tele.id));
    assert.ok(told.some((n) => /Confirm the credit days/.test(n.body)));
  });

  test("verified hands the Telecaller the sample request and tells them", async () => {
    const lead = await answered();
    setTestUser(mgr);
    assert.equal((await reviewLeadQualification({ customerId: lead.id, verdict: "verified" })).ok, true);
    const after = await row(lead.id);
    assert.equal(after.leadNextAction, QUAL_NEXT.sample);
    assert.equal(after.leadNextActionOwnerId, tele.id);
    const told = await db.select().from(notifications).where(eq(notifications.userId, tele.id));
    assert.ok(told.some((n) => /qualification verified/.test(n.title)));
  });

  test("only a manager reviews, and only at Qualification — a Telecaller cannot approve their own", async () => {
    const lead = await answered();
    setTestUser(tele);
    assert.equal((await reviewLeadQualification({ customerId: lead.id, verdict: "verified" })).ok, false);
    assert.equal((await row(lead.id)).leadQualificationReview, null);

    const early = await prospect();
    setTestUser(mgr);
    const r = await reviewLeadQualification({ customerId: early.id, verdict: "verified" });
    assert.equal(r.ok, false, "there is no Qualification to review at Prospect");
  });
});

describe("a Telecaller's material edit takes a verified review away", () => {
  const stillVerified = async (leadId: string) => (await row(leadId)).leadQualificationReview === "verified";

  const cases: Array<[string, (leadId: string) => Promise<unknown>]> = [
    ["GSTIN", (l) => saveProspectFields(l, { gstin: "29AAAAA0000A1Z5" })],
    ["application", (l) => saveProspectFields(l, { application: "Furniture lacquer" })],
    ["credit days", (l) => saveProspectFields(l, { creditDaysWanted: 45 })],
    ["buyer", (l) => saveProspectFields(l, { buyer: "The accountant" })],
    ["decision maker", (l) => saveProspectFields(l, { decisionMaker: "His son" })],
    ["monthly litres (a Prospect figure)", (l) => saveProspectFields(l, { monthlyLitres: 900 })],
    ["competitor (a Prospect figure)", (l) => saveProspectFields(l, { competitor: "Asian Paints" })],
    ["a stored answer", (l) => saveLeadQualification(l, { willing_to_test: "no" })],
    ["the GST verification state", (l) => validateGstin({ customerId: l, valid: false, note: "Does not match the name." })],
  ];
  for (const [name, edit] of cases) {
    test(`${name}: the review is voided, the history says so, and the sample is blocked until it is reviewed again`, async () => {
      const lead = await reviewed();
      assert.equal(await stillVerified(lead.id), true);
      /* The GST validation is the manager's act, so that edit is his; every other
         one is the owner's. */
      setTestUser(name === "the GST verification state" ? mgr : tele);
      await edit(lead.id);

      const after = await row(lead.id);
      assert.equal(after.leadQualificationReview, null);
      assert.equal(after.leadQualificationReviewNote, null);
      assert.equal(after.leadQualificationReviewedAt, null);
      assert.equal(after.leadQualificationReviewedById, null);

      const voided = await db.select().from(auditLog).where(and(eq(auditLog.entityId, lead.id), eq(auditLog.action, "lead.qualificationReview.void")));
      assert.equal(voided.length, 1);
      assert.equal((voided[0].beforeState as { leadQualificationReview: string }).leadQualificationReview, "verified", "the old verdict is kept in the audit");
      const line = await db.select().from(timelineEvents).where(and(eq(timelineEvents.customerId, lead.id), eq(timelineEvents.eventType, "lead_qualification_review")));
      assert.ok(line.some((t) => /no longer stands/.test(t.summary)));

      const gate = await leadGateInput(lead.id);
      assert.ok(gateTo(gate!, "sample_trial").missing.some((c) => c.id === "manager_review_pending"));
    });
  }

  test("re-saving an identical value is not a change", async () => {
    const lead = await reviewed();
    setTestUser(tele);
    await saveProspectFields(lead.id, { application: "Wood polish", creditDaysWanted: 30, buyer: "Ganesh's brother", gstin: "27ABCDE1234F1Z5" });
    await saveLeadQualification(lead.id, { willing_to_test: "yes" });
    await confirmLeadFigures({ customerId: lead.id });
    assert.equal(await stillVerified(lead.id), true);
  });

  test("a non-material edit — the next action — leaves it alone", async () => {
    const lead = await reviewed();
    setTestUser(tele);
    const r = await setLeadNextAction(lead.id, { action: "Call him Monday", date: "2026-10-05", ownerId: tele.id });
    assert.equal(r.ok, true);
    assert.equal(await stillVerified(lead.id), true);
  });

  test("the manager's own ordinary edit does not void his review, but changing the sales type does", async () => {
    const lead = await reviewed();
    setTestUser(mgr);
    await saveProspectFields(lead.id, { application: "Furniture lacquer" });
    assert.equal(await stillVerified(lead.id), true, "a manager edits knowingly");

    const changed = await setLeadSalesType(lead.id, "third_party", "It is billed through a distributor.");
    assert.equal(changed.ok, true, changed.ok ? "" : changed.error);
    assert.equal(await stillVerified(lead.id), false, "the sales type changes which conditions exist");
  });

  test("an unrelated or unchanged save never puts a sent-back lead in front of the manager again", async () => {
    setTestUser(mgr);
    const lead = await answered();
    await reviewLeadQualification({ customerId: lead.id, verdict: "clarification", note: "Which buyer?" });
    const before = await row(lead.id);
    assert.equal(before.leadNextAction, QUAL_NEXT.answer);
    const bellsBefore = (await db.select().from(notifications).where(eq(notifications.userId, mgr.id))).length;

    setTestUser(tele);
    // Saves that change nothing, and one that changes only a non-material thing.
    await saveProspectFields(lead.id, { application: "Wood polish", creditDaysWanted: 30, buyer: "Ganesh's brother" });
    await saveLeadQualification(lead.id, { willing_to_test: "yes" });
    await confirmLeadFigures({ customerId: lead.id });
    await setLeadNextAction(lead.id, { action: "Ring the buyer", date: "2026-10-05", ownerId: tele.id });

    const after = await row(lead.id);
    assert.equal(after.leadQualificationReview, "clarification", "the verdict stands");
    assert.equal(after.leadQualificationReviewNote, "Which buyer?", "and so does the manager's note");
    assert.notEqual(after.leadNextActionOwnerId, mgr.id, "the lead is still the Telecaller's to answer");
    const bellsAfter = (await db.select().from(notifications).where(eq(notifications.userId, mgr.id))).length;
    assert.equal(bellsAfter, bellsBefore, "the manager was not asked again");
  });

  test("changing the relevant answer voids the note, keeps it in the history, and asks the manager exactly once", async () => {
    setTestUser(mgr);
    const lead = await answered();
    await reviewLeadQualification({ customerId: lead.id, verdict: "clarification", note: "Which buyer?" });

    setTestUser(tele);
    await saveProspectFields(lead.id, { buyer: "The accountant" });
    const after = await row(lead.id);
    assert.equal(after.leadQualificationReview, null, "the old verdict no longer stands");
    assert.equal(after.leadNextAction, QUAL_NEXT.review);
    assert.equal(after.leadNextActionOwnerId, mgr.id, "and the manager is asked again");

    const kept = await db.select().from(auditLog).where(and(eq(auditLog.entityId, lead.id), eq(auditLog.action, "lead.qualificationReview.void")));
    assert.equal(kept.length, 1);
    assert.equal((kept[0].beforeState as { leadQualificationReviewNote: string }).leadQualificationReviewNote, "Which buyer?");

    // A second edit while it waits is not a second request.
    await saveProspectFields(lead.id, { buyer: "The accountant's son" });
    const asked = (await db.select().from(notifications).where(eq(notifications.userId, mgr.id))).filter((n) => /ready for your review/.test(n.title));
    assert.equal(asked.length, 1);
  });

  test("a note answered on the phone: resubmit without changing a field — only when sent back, and only when complete", async () => {
    const lead = await answered();
    setTestUser(tele);
    assert.equal((await resubmitForReview(lead.id)).ok, false, "nothing has been sent back yet");

    setTestUser(mgr);
    await reviewLeadQualification({ customerId: lead.id, verdict: "clarification", note: "Which buyer?" });
    setTestUser(tele2);
    // A Telecaller who does not hold the lead cannot.
    assert.equal((await resubmitForReview(lead.id)).ok, false);

    // Nor one who has it in scope (temporarily the coordinating seat) but does not own it.
    await db.update(customers).set({ leadManagerId: tele2.id }).where(eq(customers.id, lead.id));
    const notOwner = await resubmitForReview(lead.id);
    assert.equal(notOwner.ok, false, "in scope, holds lead.work, but is not the owner");
    assert.match(notOwner.ok ? "" : notOwner.error, /owns this lead/);
    await db.update(customers).set({ leadManagerId: mgr.id }).where(eq(customers.id, lead.id));

    // Nor the Sales Manager, who has it in scope and holds the desk.
    setTestUser(mgr);
    const byManager = await resubmitForReview(lead.id);
    assert.equal(byManager.ok, false, "a manager cannot resubmit on the owner's behalf");
    assert.match(byManager.ok ? "" : byManager.error, /owns this lead/);
    const untouched = await row(lead.id);
    assert.equal(untouched.leadQualificationReview, "clarification", "the refused calls changed nothing");
    assert.equal(untouched.ownerId, tele.id, "and ownership did not move");

    setTestUser(tele);
    const r = await resubmitForReview(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadQualificationReview, null);
    assert.equal(after.leadNextActionOwnerId, mgr.id);
    assert.equal((await resubmitForReview(lead.id)).ok, false, "nothing is left to resubmit");

    // An incomplete one cannot be resubmitted.
    setTestUser(mgr);
    const incomplete = await atQualification({ leadQualificationReview: "incomplete", leadQualificationReviewNote: "Everything." });
    setTestUser(tele);
    assert.equal((await resubmitForReview(incomplete.id)).ok, false);
  });
});

/* ============================================================ THIRD-PARTY */

describe("a third-party lead names who invoices it", () => {
  test("the sales type is what makes the distributor a requirement", async () => {
    const lead = await reviewed({ leadSalesType: "third_party" });
    const gate = await gateOf(lead.id);
    assert.deepEqual(gate.missing.map((c) => c.id), ["distributor_named"]);
  });
  const gateOf = async (leadId: string) => gateTo((await leadGateInput(leadId))!, "sample_trial");

  test("the Telecaller can name one — add-only, at Qualification, on a third-party lead", async () => {
    const lead = await reviewed({ leadSalesType: "third_party" });
    setTestUser(tele);
    const r = await nameLeadDistributor({ customerId: lead.id, distributorId });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const links = await db.select().from(customerDistributors).where(eq(customerDistributors.customerId, lead.id));
    assert.equal(links.length, 1);
    assert.equal((await row(lead.id)).thirdParty, false, "no mark is set — that stays customer.classify's");
    assert.equal((await row(lead.id)).leadQualificationReview, null, "a distributor link is material");
  });

  test("but only there: not on a direct lead, not at Prospect, and never a broad grant", async () => {
    const direct = await answered();
    const early = await prospect({ leadSalesType: "third_party" });
    const tp = await answered({ leadSalesType: "third_party" });
    setTestUser(tele);
    assert.equal((await nameLeadDistributor({ customerId: direct.id, distributorId })).ok, false);
    assert.equal((await nameLeadDistributor({ customerId: early.id, distributorId })).ok, false);
    const add = await addDistributor({ customerId: tp.id, distributorId });
    assert.equal(add.ok, false, "customer.classify is not the Telecaller's");
  });

  test("an account that cannot bill cannot be named", async () => {
    const lead = await answered({ leadSalesType: "third_party" });
    const [lead2] = await db.insert(customers).values({ id: id("cus"), name: "A prospect", phone: "9000000002", city: "Pune", kind: "lead" }).returning();
    setTestUser(tele);
    assert.equal((await nameLeadDistributor({ customerId: lead.id, distributorId: lead2.id })).ok, false);
  });
});

/* ============================================================== SAMPLE */

describe("Sample / Trial: only a reviewed Qualification is eligible", () => {
  const ask = (leadId: string) => requestSample(leadId, { productId, quantityCans: 2, application: "Wood polish", reasonCode: "trial" });
  const samplesOf = (leadId: string) => db.select().from(mbosSamples).where(eq(mbosSamples.customerId, leadId));

  test("no review, incomplete and clarification each refuse — and leave no sample, no approval", async () => {
    setTestUser(tele);
    for (const review of [null, "incomplete", "clarification"] as const) {
      const lead = await answered({ leadQualificationReview: review });
      const r = await ask(lead.id);
      assert.equal(r.ok, false, String(review));
      assert.equal((await samplesOf(lead.id)).length, 0, "no row is created for an ineligible lead");
    }
    assert.equal((await db.select().from(mbosApprovals)).length, 0);
  });

  test("a Prospect, or a Qualification the Telecaller has not finished, is refused too", async () => {
    setTestUser(tele);
    assert.equal((await ask((await prospect()).id)).ok, false);
    assert.equal((await ask((await atQualification()).id)).ok, false);
  });

  test("verified allows it, the Telecaller is the requester, and the manager's approval is still required", async () => {
    const lead = await reviewed();
    setTestUser(tele);
    const r = await ask(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const [s] = await samplesOf(lead.id);
    assert.equal(s.salesmanId, tele.id);
    assert.equal(s.state, "requested", "nothing leaves the godown until a manager says yes");
    assert.equal((await row(lead.id)).ownerId, tele.id, "the owner is not changed to the manager");

    setTestUser(tele);
    assert.equal((await decideSample(s.id, { approve: true })).ok, false, "the requester cannot approve");
    setTestUser(mgr);
    assert.equal((await decideSample(s.id, { approve: true })).ok, true);
    assert.equal((await samplesOf(lead.id))[0].state, "approved");
  });

  test("a legacy lead is unchanged: no sales type, no such rung, no such rule", async () => {
    const lead = await makeLead({ leadStage: "qualified", leadSalesType: null });
    assert.deepEqual(await sampleEligibility(lead.id), { applies: false });
  });

  describe("the handset's sample handover obeys the same gate", () => {
    const item = (customerId: string): SyncItem => {
      const entityId = id("smp");
      return {
        queueId: id("q"),
        entityType: "sample",
        entityId,
        op: "create",
        idempotencyKey: `${entityId}:create:${randomUUID()}`,
        clientCreatedAt: Date.now(),
        payload: { customerId, productId, quantityCans: 1 },
      } as SyncItem;
    };
    const principal = () =>
      ({ user: mgr, deviceId: `dev-${mgr.id}`, role: "manager", scope: { kind: "all" } }) as unknown as MbosPrincipal;
    beforeEach(async () => {
      await db.insert(appAccess).values({ id: id("aca"), userId: mgr.id, app: "field", role: "manager" });
      await db.insert(mbosDevices).values({ id: id("dev"), userId: mgr.id, deviceId: `dev-${mgr.id}`, active: true });
    });

    test("a funnel lead with no verified review is rejected; a verified one is accepted", async () => {
      const blocked = await answered();
      const [no] = await ingestSyncBatch(principal(), [item(blocked.id)]);
      assert.equal(no.status, "rejected", JSON.stringify(no));
      assert.equal((await samplesOf(blocked.id)).length, 0);

      const ok = await reviewed();
      const [yes] = await ingestSyncBatch(principal(), [item(ok.id)]);
      assert.equal(yes.status, "accepted", JSON.stringify(yes));
    });
  });
});

/* ============================================================ END TO END */

describe("the whole workflow, start to finish", () => {
  test("Suspect → Calling Desk → Prospect → verified → Qualification → review → edit → review again → Sample/Trial", async () => {
    // 1. The Telecaller captures the lead and works the desk.
    setTestUser(tele);
    const made = await captureLead({ ...CAPTURE(), salesType: "direct" });
    assert.ok(made.ok);
    const leadId = made.ok ? made.data.customerId : "";
    const captured = await row(leadId);
    assert.deepEqual([captured.ownerId, captured.leadSalesType, captured.leadStage], [tele.id, "direct", "suspect"]);
    await db.update(customers).set({ leadManagerId: mgr.id }).where(eq(customers.id, leadId));

    const call = await logQualificationCall({
      customerId: leadId,
      outcome: "spoke_collected",
      answers: {
        monthlyLitres: 200,
        requiredProductId: productId,
        competitor: "Local thinner",
        decisionMaker: "Owner",
      },
    });
    assert.equal(call.ok && call.data.result, "ready", call.ok ? "" : call.error);

    // 2. Promotion: unverified, and owed by the manager.
    const promoted = await convertLeadToProspect({ customerId: leadId, reasonCode: "regular_requirement", customerType: "manufacturer", salesType: "direct", contactPerson: "Ganesh" });
    assert.equal(promoted.ok, true, promoted.ok ? "" : promoted.error);
    let lead = await row(leadId);
    assert.equal(lead.leadStage, "prospect");
    assert.equal(lead.leadVerifiedAt, null);
    assert.equal(lead.leadNextActionOwnerId, mgr.id);
    // …and Qualification cannot be written yet.
    assert.equal((await saveProspectFields(leadId, { application: "Wood polish" })).ok, false);

    // 3. The manager verifies; Qualification opens by itself.
    setTestUser(mgr);
    assert.equal((await recordLeadValidationCall(leadId, { answers: {}, outcome: "verified" })).ok, true);
    lead = await row(leadId);
    assert.equal(lead.leadStage, "qualification");
    assert.equal(lead.ownerId, tele.id);
    assert.equal(lead.leadNextActionOwnerId, tele.id);

    // 4. The owner collects the eight answers. The GST number is entered, not validated.
    setTestUser(tele);
    for (const r of [
      await saveProspectFields(leadId, { gstin: "27ABCDE1234F1Z5", application: "Wood polish", creditDaysWanted: 30, buyer: "Ganesh's brother" }),
      await saveLeadQualification(leadId, { ...QUALIFICATION_ANSWERS }),
      await confirmLeadFigures({ customerId: leadId }),
    ]) {
      assert.equal(r.ok, true, r.ok ? "" : r.error);
    }
    assert.equal((await row(leadId)).leadNextActionOwnerId, mgr.id, "it is now with the manager");
    assert.equal((await ask(leadId)).ok, false, "not yet: nothing has been reviewed");

    // 5. The manager validates the GST number, reviews and verifies.
    setTestUser(mgr);
    assert.equal((await validateGstin({ customerId: leadId, valid: true })).ok, true);
    assert.equal((await reviewLeadQualification({ customerId: leadId, verdict: "verified" })).ok, true);
    assert.equal((await row(leadId)).leadNextActionOwnerId, tele.id);

    // 6. The Telecaller changes a material field — the approval no longer stands.
    setTestUser(tele);
    assert.equal((await saveProspectFields(leadId, { creditDaysWanted: 45 })).ok, true);
    assert.equal((await row(leadId)).leadQualificationReview, null);
    assert.equal((await ask(leadId)).ok, false, "a voided review blocks the sample again");
    assert.equal((await row(leadId)).leadNextActionOwnerId, mgr.id, "and it is back with the manager");

    // 7. Reviewed again — now the sample is eligible, requested by the Telecaller, approved by the manager.
    setTestUser(mgr);
    assert.equal((await reviewLeadQualification({ customerId: leadId, verdict: "verified" })).ok, true);
    setTestUser(tele);
    const asked = await ask(leadId);
    assert.equal(asked.ok, true, asked.ok ? "" : asked.error);
    setTestUser(mgr);
    const sample = (await db.select().from(mbosSamples).where(eq(mbosSamples.customerId, leadId)))[0];
    assert.equal((await decideSample(sample.id, { approve: true })).ok, true);
    assert.equal((await row(leadId)).ownerId, tele.id, "the owner was the Telecaller throughout");
    assert.equal((await leadRow(leadId))?.leadCreditDaysWanted, 45);
  });

  const ask = (leadId: string) =>
    requestSample(leadId, { productId, quantityCans: 2, application: "Wood polish", reasonCode: "trial" });
});
