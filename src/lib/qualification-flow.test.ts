/**
 * QUALIFICATION: A SALESMAN COLLECTS, THE SALES MANAGER THE LEAD IS UNDER
 * VALIDATES THE GST NUMBER AND REVIEWS.
 *
 *   A  Salesman-created lead, end to end, up to a gate that is open for Sample/Trial;
 *   B  GST: valid passes, invalid blocks and goes back with its reason, a changed
 *      number clears the validation and takes a standing approval away;
 *   C  the two negative verdicts go back to the Salesman, and an edit asks again;
 *   D  Sales Manager-created lead: she does not fill the form, a Salesman does,
 *      and she cannot approve her own work;
 *   E  who may and who may not — the Salesman, a different Sales Manager, a
 *      manager seated as a Sales Manager elsewhere, and the owner;
 *   F  "verified" needs every answer and a validated number;
 *   G  the handset's door to the same answers.
 *
 * Real actions against `mahekone_test`. The workspace travels on a request
 * header in production; `setTestWorkspace` stands in for it.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  customers,
  employeeReporting,
  employees,
  mbosUserTerritories,
  notifications,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { captureLead } from "@/lib/actions/lead-intake";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { reassignLead } from "@/lib/actions/sales";
import { saveLeadQualification, saveProspectFields } from "@/lib/actions/leads";
import { validateGstin } from "@/lib/actions/lead-gst";
import { verifyProspect } from "@/lib/actions/sales-manager-pipeline";
import { reviewLeadQualification } from "@/lib/actions/lead-qualification-review";
import { gateTo } from "@/lib/engines/lead-gates";
import { CRM_SALES_MANAGER_WORKSPACE } from "@/proxy";
import { setTestWorkspace } from "@/lib/services/crm-sales-manager-scope";
import { leadGateInput } from "@/lib/services/lead-service";
import { QUAL_NEXT } from "@/lib/services/lead-qualification-flow-service";
import { gstValidatorRefusal, requireQualificationApprover } from "@/lib/services/lead-verifier";
import type { MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";
import { QUALIFICATION_ANSWERS, qualificationColumns } from "@/lib/qualification-fixtures";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type Level = "associate" | "manager";

let seema: typeof users.$inferSelect; // the Sales Manager: CRM ASSOCIATE + the module
let other: typeof users.$inferSelect; // a different Sales Manager, same shape
let globalMgr: typeof users.$inferSelect; // a manager-level Sales Manager seated elsewhere
let salesman: typeof users.$inferSelect;
let productId: string;

async function makeUser(name: string, level: Level, apps: [string, Level][], modules: string[] = []) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: level,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  for (const [app, role] of apps) {
    await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: app as never, role });
  }
  for (const key of modules) {
    await db.insert(appModuleAccess).values({ id: id("ama"), userId: row.id, app: "crm", module: key });
  }
  return row;
}

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const told = async (userId: string) => db.select().from(notifications).where(eq(notifications.userId, userId));

const asSalesman = () => {
  setTestWorkspace(null);
  setTestUser(salesman);
};
const asSeema = () => {
  setTestWorkspace(CRM_SALES_MANAGER_WORKSPACE);
  setTestUser(seema);
};

const prospectFields = () => ({
  customerType: "retailer" as const,
  leadMonthlyVolumeLitres: 300,
  leadEstimatedPotentialPaise: 9_000_000,
  leadCompetitor: "Local thinner",
  leadRequiredProductId: productId,
  contactPerson: "Ganesh",
  leadDecisionMaker: "Ganesh",
  leadFiguresConfirmedAt: new Date(),
});

/** A lead at Prospect, under Seema's seat, owned as asked. */
async function makeProspect(ownerId: string | null, over: Partial<typeof customers.$inferInsert> = {}) {
  const [r] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nashik",
      kind: "lead",
      leadStage: "prospect",
      leadSalesType: "direct",
      leadSource: "manual",
      leadStageSince: "2026-10-05",
      leadLastActivityDate: "2026-10-05",
      ownerId,
      salesManagerId: seema.id,
      ...prospectFields(),
      ...over,
    })
    .returning();
  return r;
}

const verify = (customerId: string) =>
  verifyProspect({
    customerId,
    outcome: "verified",
    answers: { visited: "Yes", explained: "Yes", genuine_interest: "Yes", ready_for_trial: "Yes" },
    corrections: [],
  });

/** The Salesman answers all eight, through the same actions the screens call. */
async function salesmanAnswersAll(customerId: string) {
  asSalesman();
  const cols = qualificationColumns();
  const a = await saveProspectFields(customerId, {
    gstin: cols.gstin,
    application: cols.leadApplication,
    creditDaysWanted: cols.leadCreditDaysWanted,
    decisionMaker: cols.leadDecisionMaker,
  } as never);
  assert.ok(a.ok, a.ok ? "" : a.error);
  const b = await saveLeadQualification(customerId, { ...QUALIFICATION_ANSWERS });
  assert.ok(b.ok, b.ok ? "" : b.error);
}

const missingForSample = async (customerId: string) => {
  const gate = await leadGateInput(customerId);
  assert.ok(gate);
  return gateTo(gate, "sample_trial").missing.map((m) => m.id);
};

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});
after(async () => {
  setTestUser(null);
  setTestWorkspace(null);
  await db.$client.end();
});
beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_stage_transitions, lead_verification_corrections, mbos_lead_validations, mbos_tasks,
      notifications, timeline_events, audit_log, app_module_access, app_access, mbos_user_territories,
      employee_reporting, employees, customers, products, users, app_settings restart identity cascade`);
  invalidateConfig();
  await seedConfig();

  seema = await makeUser("Seema Roy", "associate", [["crm", "associate"]], ["crm.sales-manager"]);
  other = await makeUser("Other Manager", "associate", [["crm", "associate"]], ["crm.sales-manager"]);
  globalMgr = await makeUser("Global Manager", "manager", [["crm", "manager"]], ["crm.sales-manager"]);
  salesman = await makeUser("Rakesh Field", "associate", [["field", "associate"]]);
  await db.insert(mbosUserTerritories).values({ id: id("ut"), userId: salesman.id, kind: "state", region: "Madhya Pradesh", parent: "" });
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
});

/* ═══════════════════════════════════════════ A — the Salesman-created lead */

describe("A: a Salesman's lead, from the handset to an open Sample/Trial gate", () => {
  test("born under his Sales Manager, verified by her, collected by him, GST and review by her", async () => {
    /* The org chart names Seema as the Salesman's manager. */
    const [mgr, rep] = await Promise.all(
      [seema.name, salesman.name].map(async (name, i) =>
        (
          await db
            .insert(employees)
            .values({ id: id("emp"), employeeCode: `Q-${i}`, name, status: "active", rowNumber: 800 + i, raw: {}, rowHash: `q-${i}-${randomUUID()}` })
            .returning()
        )[0],
      ),
    );
    await db.insert(employeeReporting).values({ id: id("er"), employeeId: rep.id, managerId: mgr.id });

    const entityId = id("mbos");
    const principal = { user: salesman, deviceId: "probe", role: "associate", scope: { kind: "own", userIds: [salesman.id] } } as MbosPrincipal;
    const item: SyncItem = {
      queueId: id("q"),
      entityType: "lead",
      entityId,
      op: "create",
      idempotencyKey: `${entityId}:create:${randomUUID()}`,
      clientCreatedAt: Date.now(),
      payload: { name: "Rakesh Paints", companyName: "Rakesh Paints", mobile: "9820011999", city: "Rewa", salesType: "direct", stage: "suspect" },
    };
    const [made] = await ingestSyncBatch(principal, [item]);
    assert.equal(made.status, "accepted", JSON.stringify(made));
    const born = await row(entityId);
    assert.equal(born.ownerId, salesman.id);
    assert.equal(born.salesManagerId, seema.id, "the responsible Sales Manager is known immediately");

    /* Stand it at Prospect (the Calling Desk's step is not what this pins). */
    await db.update(customers).set({ leadStage: "prospect", ...prospectFields() }).where(eq(customers.id, entityId));

    /* The Sales Manager verifies; Qualification opens and is the SALESMAN's. */
    asSeema();
    const v = await verify(entityId);
    assert.equal(v.ok, true, v.ok ? "" : v.error);
    const opened = await row(entityId);
    assert.equal(opened.leadStage, "qualification");
    assert.equal(opened.leadNextAction, QUAL_NEXT.complete);
    assert.equal(opened.leadNextActionOwnerId, salesman.id);

    /* He answers all eight. GST is entered, not yet validated. */
    await salesmanAnswersAll(entityId);
    const stillOpen = await missingForSample(entityId);
    assert.ok(stillOpen.includes("gst_verified"), "the number is entered, not yet validated");
    for (const answered of ["application_understood", "trial_plan", "people_identified", "price_and_credit", "delivery_workable", "willing_to_test", "next_step_dated"]) {
      assert.ok(!stillOpen.includes(answered), answered + " is answered");
    }

    /* Complete for review: the next action is hers, with the bell. */
    const handed = await row(entityId);
    assert.equal(handed.leadNextAction, QUAL_NEXT.review);
    assert.equal(handed.leadNextActionOwnerId, seema.id);
    assert.ok((await told(seema.id)).some((n) => /ready for your review/i.test(n.title)));

    /* She validates GST, then verifies. */
    asSeema();
    const g = await validateGstin({ customerId: entityId, valid: true });
    assert.equal(g.ok, true, g.ok ? "" : g.error);
    const afterGst = await row(entityId);
    assert.equal(afterGst.gstVerified, true);
    assert.equal(afterGst.gstVerifiedById, seema.id, "who validated it is recorded");
    assert.ok(afterGst.gstVerifiedAt, "and when");

    const r = await reviewLeadQualification({ customerId: entityId, verdict: "verified" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const done = await row(entityId);
    assert.equal(done.leadQualificationReview, "verified");
    assert.equal(done.leadNextAction, QUAL_NEXT.sample);
    assert.equal(done.leadNextActionOwnerId, salesman.id, "the Salesman requests the sample");

    /* And the gate to Sample/Trial is open. */
    const gate = await leadGateInput(entityId);
    assert.ok(gate);
    assert.deepEqual(gateTo(gate, "sample_trial").missing, []);
  });
});

/* ══════════════════════════════════════════════════════════════ B — GST */

describe("B: GST is validated by the Sales Manager, once, against the number it was made on", () => {
  async function readyForReview() {
    const lead = await makeProspect(salesman.id);
    asSeema();
    assert.equal((await verify(lead.id)).ok, true);
    await salesmanAnswersAll(lead.id);
    return lead;
  }

  test("an invalid number blocks approval and goes back to the Salesman with its reason", async () => {
    const lead = await readyForReview();
    asSeema();
    const noReason = await validateGstin({ customerId: lead.id, valid: false });
    assert.equal(noReason.ok, false, "a refusal has to say what is wrong");

    const refused = await validateGstin({ customerId: lead.id, valid: false, note: "The last four characters are wrong." });
    assert.equal(refused.ok, true, refused.ok ? "" : refused.error);
    assert.equal((await row(lead.id)).gstVerified, false);

    const v = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(v.ok, false, "cannot be verified over a refused number");
    assert.match(!v.ok ? v.error : "", /GST/i);

    const back = await row(lead.id);
    assert.equal(back.leadNextAction, QUAL_NEXT.gst);
    assert.equal(back.leadNextActionOwnerId, salesman.id);
    assert.match(back.leadNextActionOutcome ?? "", /last four characters/);
    assert.ok((await told(salesman.id)).some((n) => /GST number was refused/i.test(n.title) && /last four characters/.test(n.body ?? "")));
  });

  test("correcting the number clears the refusal, and it can be validated and approved", async () => {
    const lead = await readyForReview();
    asSeema();
    await validateGstin({ customerId: lead.id, valid: false, note: "Wrong." });

    asSalesman();
    const fixed = await saveProspectFields(lead.id, { gstin: "27AAAPL1234C1ZV" } as never);
    assert.ok(fixed.ok, fixed.ok ? "" : fixed.error);
    const cleared = await row(lead.id);
    assert.equal(cleared.gstin, "27AAAPL1234C1ZV");
    assert.notEqual(cleared.gstVerified, true, "a validation belongs to the number it was made on");

    asSeema();
    assert.equal((await validateGstin({ customerId: lead.id, valid: true })).ok, true);
    assert.equal((await reviewLeadQualification({ customerId: lead.id, verdict: "verified" })).ok, true);
  });

  test("changing the number AFTER approval clears the validation and takes the approval away", async () => {
    const lead = await readyForReview();
    asSeema();
    assert.equal((await validateGstin({ customerId: lead.id, valid: true })).ok, true);
    assert.equal((await reviewLeadQualification({ customerId: lead.id, verdict: "verified" })).ok, true);
    assert.equal((await row(lead.id)).leadQualificationReview, "verified");

    asSalesman();
    const changed = await saveProspectFields(lead.id, { gstin: "29AAAAA0000A1Z5" } as never);
    assert.ok(changed.ok, changed.ok ? "" : changed.error);
    const after = await row(lead.id);
    assert.equal(after.leadQualificationReview, null, "the approval no longer stands");
    assert.notEqual(after.gstVerified, true, "and neither does the validation");
    assert.ok((await missingForSample(lead.id)).includes("gst_verified"));
  });

  test("nobody but the responsible Sales Manager validates it", async () => {
    const lead = await readyForReview();
    for (const [who, label] of [
      [salesman, "the Salesman who entered it"],
      [other, "a different Sales Manager"],
    ] as const) {
      setTestWorkspace(null);
      setTestUser(who);
      const r = await validateGstin({ customerId: lead.id, valid: true });
      assert.equal(r.ok, false, label);
    }
    assert.notEqual((await row(lead.id)).gstVerified, true);
  });
});

/* ══════════════════════════════════════════════ C — the negative verdicts */

describe("C: incomplete and clarification go back to the Salesman, and an edit asks again", () => {
  for (const verdict of ["incomplete", "clarification"] as const) {
    test(verdict, async () => {
      const lead = await makeProspect(salesman.id);
      asSeema();
      assert.equal((await verify(lead.id)).ok, true);
      await salesmanAnswersAll(lead.id);

      asSeema();
      const noNote = await reviewLeadQualification({ customerId: lead.id, verdict });
      assert.equal(noNote.ok, false, "a negative verdict has to say what is wanted");
      const r = await reviewLeadQualification({ customerId: lead.id, verdict, note: "Which pack are they actually buying?" });
      assert.equal(r.ok, true, r.ok ? "" : r.error);

      const held = await row(lead.id);
      assert.equal(held.leadQualificationReview, verdict);
      assert.equal(held.leadNextAction, QUAL_NEXT.answer);
      assert.equal(held.leadNextActionOwnerId, salesman.id);
      assert.match(held.leadNextActionOutcome ?? "", /Which pack/);
      assert.ok((await told(salesman.id)).some((n) => /Which pack/.test(n.body ?? "")), "the note travels in the message");

      /* His material edit asks for the review again. */
      asSalesman();
      const edit = await saveLeadQualification(lead.id, { trial_pack: "5 L" });
      assert.ok(edit.ok, edit.ok ? "" : edit.error);
      assert.equal((await row(lead.id)).leadQualificationReview, null, "the old verdict was about different answers");
    });
  }
});

/* ═════════════════════════════════════ D — the Sales Manager's own lead */

describe("D: a lead the Sales Manager raised herself", () => {
  test("she verifies; a Salesman is named; he collects; she validates and approves", async () => {
    asSeema();
    const made = await captureLead({
      salesType: "direct",
      name: "J P paints and hardware stores",
      phone: "9876501234",
      city: "Nashik",
      source: "telecalling",
    } as never);
    assert.ok(made.ok, made.ok ? "" : made.error);
    const leadId = made.data.customerId;
    assert.equal((await row(leadId)).salesManagerId, seema.id);
    assert.equal((await row(leadId)).ownerId, null);

    await db.update(customers).set({ leadStage: "prospect", ...prospectFields() }).where(eq(customers.id, leadId));
    assert.equal((await verify(leadId)).ok, true);

    /* Qualification is open, and what she owes is to NAME somebody. */
    const opened = await row(leadId);
    assert.equal(opened.leadStage, "qualification");
    assert.equal(opened.leadNextAction, QUAL_NEXT.assign);
    assert.equal(opened.leadNextActionOwnerId, seema.id);

    /* She does not fill it in herself. */
    const own = await saveLeadQualification(leadId, { trial_product: "PU Thinner" });
    assert.equal(own.ok, false);
    assert.match(!own.ok ? own.error : "", /Salesman who owns this lead completes/);
    const ownCols = await saveProspectFields(leadId, { application: "Wood polish" } as never);
    assert.equal(ownCols.ok, false);

    /* She names a Salesman; he collects. */
    const named = await reassignLead({ leadId, salesmanId: salesman.id });
    assert.equal(named.ok, true, named.ok ? "" : named.error);
    assert.equal((await row(leadId)).ownerId, salesman.id);
    await salesmanAnswersAll(leadId);

    asSeema();
    assert.equal((await validateGstin({ customerId: leadId, valid: true })).ok, true);
    const r = await reviewLeadQualification({ customerId: leadId, verdict: "verified" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.deepEqual(await missingForSample(leadId), []);
  });

  test("a lead she owns herself cannot be approved by her — it needs a Salesman", async () => {
    const lead = await makeProspect(seema.id);
    asSeema();
    assert.equal((await verify(lead.id)).ok, true);
    /* Her own answers, written the way the engine reads them, would be exactly
       the self-approval this refuses. */
    await db
      .update(customers)
      .set({
        gstin: "27ABCDE1234F1Z5",
        gstVerified: true,
        gstVerifiedAt: new Date(),
        gstVerifiedById: seema.id,
        leadApplication: "Wood polish",
        leadCreditDaysWanted: 30,
        leadDecisionMaker: "Ganesh",
        leadQualification: { ...QUALIFICATION_ANSWERS },
      })
      .where(eq(customers.id, lead.id));
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /own this lead|collected/i);
    assert.equal((await row(lead.id)).leadQualificationReview, null);
    const g = await validateGstin({ customerId: lead.id, valid: true });
    assert.equal(g.ok, false, "and she cannot validate the number she entered either");
  });
});

/* ═══════════════════════════════════════════════════ E — who may and may not */

describe("E: authorization follows the lead's own Sales Manager", () => {
  async function complete() {
    const lead = await makeProspect(salesman.id);
    asSeema();
    assert.equal((await verify(lead.id)).ok, true);
    await salesmanAnswersAll(lead.id);
    asSeema();
    assert.equal((await validateGstin({ customerId: lead.id, valid: true })).ok, true);
    return lead;
  }

  test("the Salesman cannot approve", async () => {
    const lead = await complete();
    asSalesman();
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadQualificationReview, null);
  });

  test("a different associate Sales Manager cannot approve", async () => {
    const lead = await complete();
    setTestWorkspace(CRM_SALES_MANAGER_WORKSPACE);
    setTestUser(other);
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadQualificationReview, null);
  });

  test("a manager-level Sales Manager seated on a DIFFERENT lead is not its reviewer through generic capability", async () => {
    const lead = await complete();
    /* Whether the manager's territory scope reaches the lead at all depends on
       the org chart; what is pinned here is that, scope or no scope, the
       capability alone never makes her its approver or its GST validator. */
    setTestWorkspace(null);
    setTestUser(globalMgr);
    const approver = await requireQualificationApprover(lead.id);
    assert.equal(approver.ok, false);
    assert.match(!approver.ok ? approver.message : "", /different Sales Manager/i);
    const gst = await gstValidatorRefusal(globalMgr, { ownerId: salesman.id, salesManagerId: seema.id });
    assert.match(gst ?? "", /own Sales Manager/i);
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadQualificationReview, null);
  });

  test("the responsible Sales Manager can", async () => {
    const lead = await complete();
    asSeema();
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });
});

/* ═══════════════════════════════════════ F — verified needs everything */

describe("F: 'verified' needs every answer and a validated number", () => {
  test("a missing answer is named, and nothing is recorded", async () => {
    const lead = await makeProspect(salesman.id);
    asSeema();
    assert.equal((await verify(lead.id)).ok, true);
    await salesmanAnswersAll(lead.id);
    asSalesman();
    assert.ok((await saveLeadQualification(lead.id, { delivery_location: "" })).ok);

    asSeema();
    assert.equal((await validateGstin({ customerId: lead.id, valid: true })).ok, true);
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /deliver/i);
    assert.equal((await row(lead.id)).leadQualificationReview, null);
  });

  test("without a validated number, even a complete checklist cannot be verified", async () => {
    const lead = await makeProspect(salesman.id);
    asSeema();
    assert.equal((await verify(lead.id)).ok, true);
    await salesmanAnswersAll(lead.id);
    asSeema();
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /GST/i);
  });

  test("a 'no' to willingness holds the lead", async () => {
    const lead = await makeProspect(salesman.id);
    asSeema();
    assert.equal((await verify(lead.id)).ok, true);
    await salesmanAnswersAll(lead.id);
    asSalesman();
    assert.ok((await saveLeadQualification(lead.id, { willing_to_test: "no" })).ok);
    assert.ok((await missingForSample(lead.id)).includes("willing_to_test"));
  });

  test("an answer the gate cannot read is refused in words", async () => {
    const lead = await makeProspect(salesman.id);
    asSeema();
    assert.equal((await verify(lead.id)).ok, true);
    asSalesman();
    const bad = await saveLeadQualification(lead.id, { price_reaction: "delighted" });
    assert.equal(bad.ok, false);
    const stored = await saveLeadQualification(lead.id, { invented_key: "x", trial_product: "PU Thinner" });
    assert.ok(stored.ok);
    const q = (await row(lead.id)).leadQualification as Record<string, unknown>;
    assert.equal(q.trial_product, "PU Thinner");
    assert.equal(q.invented_key, undefined, "a key nobody declared is dropped, not stored");
  });
});

/* ═════════════════════════════════════════════ G — the handset's own door */

describe("G: the handset sends the same answers through the sync handler", () => {
  const principalFor = (user: typeof users.$inferSelect) =>
    ({ user, deviceId: "probe", role: "associate", scope: { kind: "own", userIds: [user.id] } }) as MbosPrincipal;

  const update = (entityId: string, payload: Record<string, unknown>): SyncItem => ({
    queueId: id("q"),
    entityType: "lead",
    entityId,
    op: "update",
    idempotencyKey: `${entityId}:update:${randomUUID()}`,
    clientCreatedAt: Date.now(),
    payload,
  });

  test("valid answers are merged, an unreadable one is dropped, the rest survive", async () => {
    const lead = await makeProspect(salesman.id);
    asSeema();
    assert.equal((await verify(lead.id)).ok, true);

    const [result] = await ingestSyncBatch(principalFor(salesman), [
      update(lead.id, {
        qualification: { trial_product: "PU Thinner", price_reaction: "delighted", willing_to_test: "yes", buyer_name: "Suresh" },
      }),
    ]);
    assert.equal(result.status, "accepted", JSON.stringify(result));
    const q = (await row(lead.id)).leadQualification as Record<string, unknown>;
    assert.equal(q.trial_product, "PU Thinner");
    assert.equal(q.willing_to_test, "yes");
    assert.equal(q.buyer_name, "Suresh");
    assert.equal(q.price_reaction, undefined, "the reaction the gate cannot read was not stored");
  });

  test("the Sales Manager is refused on the handset too", async () => {
    const lead = await makeProspect(salesman.id);
    asSeema();
    assert.equal((await verify(lead.id)).ok, true);
    const [result] = await ingestSyncBatch(principalFor(seema), [update(lead.id, { qualification: { trial_product: "PU Thinner" } })]);
    assert.equal(result.status, "rejected", JSON.stringify(result));
    const q = ((await row(lead.id)).leadQualification ?? {}) as Record<string, unknown>;
    assert.equal(q.trial_product, undefined);
  });
});
