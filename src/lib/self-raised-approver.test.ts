/**
 * A LEAD THE SALES MANAGER RAISED HERSELF IS APPROVED BY THE PERSON MAHEK
 * DESIGNATES — and SHE collects its eight answers.
 *
 *   A  designated: verification, GST and the review are theirs; she does none of
 *      them, and she does fill the form;
 *   B  the designated person can SEE the lead (the coordinating seat), at capture
 *      and for leads that already existed, and the pass is idempotent;
 *   C  off by default, and off for a typo or for the Sales Manager herself —
 *      nothing changes until somebody is designated;
 *   D  a lead that is not self-raised follows the ordinary rule whatever is set.
 *
 * Real actions against `mahekone_test`. The workspace travels on a request
 * header in production; `setTestWorkspace` stands in for it.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, customers, notifications, products, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig, updateSetting } from "@/lib/config/store";
import { captureLead } from "@/lib/actions/lead-intake";
import { saveLeadQualification, saveProspectFields } from "@/lib/actions/leads";
import { validateGstin } from "@/lib/actions/lead-gst";
import { verifyProspect } from "@/lib/actions/sales-manager-pipeline";
import { reviewLeadQualification } from "@/lib/actions/lead-qualification-review";
import { gateTo } from "@/lib/engines/lead-gates";
import { CRM_SALES_MANAGER_WORKSPACE } from "@/proxy";
import { setTestWorkspace } from "@/lib/services/crm-sales-manager-scope";
import { leadGateInput } from "@/lib/services/lead-service";
import { QUAL_NEXT } from "@/lib/services/lead-qualification-flow-service";
import { approverFor, designatedApprover, isSelfRaised } from "@/lib/services/lead-verifier";
import { ensureSelfRaisedVerifierSeats } from "@/lib/services/self-raised-verifier-service";
import { QUALIFICATION_ANSWERS, qualificationColumns } from "@/lib/qualification-fixtures";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type Level = "associate" | "manager";

let seema: typeof users.$inferSelect; // the Sales Manager: CRM ASSOCIATE + the module
let pritesh: typeof users.$inferSelect; // the designated approver: manager level
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

const designate = async (email: string) => {
  const r = await updateSetting("leads.selfRaisedVerifierEmail", email, pritesh.id);
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r));
  invalidateConfig();
};

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const told = async (userId: string) => db.select().from(notifications).where(eq(notifications.userId, userId));

const asSeema = () => {
  setTestWorkspace(CRM_SALES_MANAGER_WORKSPACE);
  setTestUser(seema);
};
const asPritesh = () => {
  setTestWorkspace(null);
  setTestUser(pritesh);
};
const asSalesman = () => {
  setTestWorkspace(null);
  setTestUser(salesman);
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

/** A Prospect under Seema's seat, owned as asked. */
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
  pritesh = await makeUser("Pritesh Bipin Doshi", "manager", [["crm", "manager"]]);
  salesman = await makeUser("Rakesh Field", "associate", [["field", "associate"]]);
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
});

/* ═══════════════════════════════════════════════ the definition */

describe("what a lead she raised herself is", () => {
  test("she holds the seat, and she owns it or nobody does", () => {
    assert.equal(isSelfRaised({ ownerId: null, salesManagerId: "sm" }), true);
    assert.equal(isSelfRaised({ ownerId: "sm", salesManagerId: "sm" }), true);
    assert.equal(isSelfRaised({ ownerId: "salesman", salesManagerId: "sm" }), false);
    assert.equal(isSelfRaised({ ownerId: null, salesManagerId: null }), false, "no seat, nothing to approve on her behalf");
  });
});

/* ═══════════════════════════════════ A — the designated person approves */

describe("A: the designated person verifies, validates GST and reviews; she collects", () => {
  test("end to end, owned by her", async () => {
    await designate(pritesh.email!);
    const lead = await makeProspect(seema.id);
    assert.equal(await ensureSelfRaisedVerifierSeats(), 1, "so that they can see it");
    assert.equal((await row(lead.id)).leadManagerId, pritesh.id);

    /* She does not verify her own lead — and is told who does. */
    asSeema();
    const own = await verify(lead.id);
    assert.equal(own.ok, false);
    assert.match(!own.ok ? own.error : "", /Pritesh Bipin Doshi verifies it/);
    assert.equal((await row(lead.id)).leadStage, "prospect");

    /* He does, and Qualification opens as HERS to collect. */
    asPritesh();
    const v = await verify(lead.id);
    assert.equal(v.ok, true, v.ok ? "" : v.error);
    const opened = await row(lead.id);
    assert.equal(opened.leadStage, "qualification");
    assert.equal(opened.leadVerifiedById, pritesh.id);
    assert.equal(opened.leadNextAction, QUAL_NEXT.complete);
    assert.equal(opened.leadNextActionOwnerId, seema.id, "she collects the answers");

    /* She fills the form. */
    asSeema();
    const cols = qualificationColumns();
    const a = await saveProspectFields(lead.id, {
      gstin: cols.gstin,
      application: cols.leadApplication,
      creditDaysWanted: cols.leadCreditDaysWanted,
      decisionMaker: cols.leadDecisionMaker,
    } as never);
    assert.ok(a.ok, a.ok ? "" : a.error);
    const b = await saveLeadQualification(lead.id, { ...QUALIFICATION_ANSWERS });
    assert.ok(b.ok, b.ok ? "" : b.error);

    /* The review is asked of HIM, not of her. */
    const handed = await row(lead.id);
    assert.equal(handed.leadNextAction, QUAL_NEXT.review);
    assert.equal(handed.leadNextActionOwnerId, pritesh.id);
    assert.ok((await told(pritesh.id)).some((n) => /ready for your review/i.test(n.title)));

    /* She cannot validate the number, nor approve. */
    const gstOwn = await validateGstin({ customerId: lead.id, valid: true });
    assert.equal(gstOwn.ok, false);
    assert.match(!gstOwn.ok ? gstOwn.error : "", /Pritesh Bipin Doshi validates its GST/);
    const revOwn = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(revOwn.ok, false);
    assert.match(!revOwn.ok ? revOwn.error : "", /Pritesh Bipin Doshi/);
    assert.equal((await row(lead.id)).leadQualificationReview, null);

    /* He validates and approves; the gate to Sample/Trial opens. */
    asPritesh();
    const g = await validateGstin({ customerId: lead.id, valid: true });
    assert.equal(g.ok, true, g.ok ? "" : g.error);
    assert.equal((await row(lead.id)).gstVerifiedById, pritesh.id, "the record says who validated it");
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const done = await row(lead.id);
    assert.equal(done.leadQualificationReview, "verified");
    assert.equal(done.leadNextAction, QUAL_NEXT.sample);
    assert.equal(done.leadNextActionOwnerId, seema.id, "and the sample is hers to request");
    const gate = await leadGateInput(lead.id);
    assert.ok(gate);
    assert.deepEqual(gateTo(gate, "sample_trial").missing, []);
  });

  test("a lead nobody owns: she collects it too, and a refused GST number comes back to her", async () => {
    await designate(pritesh.email!);
    const lead = await makeProspect(null);
    await ensureSelfRaisedVerifierSeats();
    asPritesh();
    assert.equal((await verify(lead.id)).ok, true);
    const opened = await row(lead.id);
    assert.equal(opened.leadNextAction, QUAL_NEXT.complete);
    assert.equal(opened.leadNextActionOwnerId, seema.id, "the seat holder, where nobody owns it");

    asSeema();
    const cols = qualificationColumns();
    assert.ok((await saveProspectFields(lead.id, { gstin: cols.gstin, application: cols.leadApplication, creditDaysWanted: 30, decisionMaker: "Ganesh" } as never)).ok);
    assert.ok((await saveLeadQualification(lead.id, { ...QUALIFICATION_ANSWERS })).ok);

    asPritesh();
    const refused = await validateGstin({ customerId: lead.id, valid: false, note: "The last four characters are wrong." });
    assert.equal(refused.ok, true, refused.ok ? "" : refused.error);
    const back = await row(lead.id);
    assert.equal(back.leadNextAction, QUAL_NEXT.gst);
    assert.equal(back.leadNextActionOwnerId, seema.id);
    assert.ok((await told(seema.id)).some((n) => /GST number was refused/i.test(n.title)));
  });

  test("the answers she collects are still hers to change, and a change asks him again", async () => {
    await designate(pritesh.email!);
    const lead = await makeProspect(seema.id);
    await ensureSelfRaisedVerifierSeats();
    asPritesh();
    assert.equal((await verify(lead.id)).ok, true);
    asSeema();
    const cols = qualificationColumns();
    assert.ok((await saveProspectFields(lead.id, { gstin: cols.gstin, application: cols.leadApplication, creditDaysWanted: 30, decisionMaker: "Ganesh" } as never)).ok);
    assert.ok((await saveLeadQualification(lead.id, { ...QUALIFICATION_ANSWERS })).ok);
    asPritesh();
    assert.equal((await validateGstin({ customerId: lead.id, valid: true })).ok, true);
    assert.equal((await reviewLeadQualification({ customerId: lead.id, verdict: "verified" })).ok, true);

    asSeema();
    assert.ok((await saveLeadQualification(lead.id, { trial_pack: "5 L" })).ok);
    assert.equal((await row(lead.id)).leadQualificationReview, null, "the approval was about different answers");
  });
});

/* ═══════════════════════════════════════════ B — he can see the lead */

describe("B: the designated person is seated on the leads she raised", () => {
  test("at capture, where she owns it or nobody does", async () => {
    await designate(pritesh.email!);
    asSeema();
    const made = await captureLead({
      salesType: "direct",
      name: "J P paints and hardware stores",
      phone: "9876501234",
      city: "Nashik",
      source: "telecalling",
    } as never);
    assert.ok(made.ok, made.ok ? "" : made.error);
    const c = await row(made.data.customerId);
    assert.equal(c.salesManagerId, seema.id);
    assert.equal(c.leadManagerId, pritesh.id, "seated at once");
  });

  test("not on a lead she raises FOR a Salesman — that one is the Salesman's", async () => {
    await designate(pritesh.email!);
    asSeema();
    const made = await captureLead({
      salesType: "direct",
      name: "For a Salesman",
      phone: "9876501235",
      city: "Nashik",
      source: "telecalling",
      ownerId: salesman.id,
    } as never);
    assert.ok(made.ok, made.ok ? "" : made.error);
    assert.equal((await row(made.data.customerId)).leadManagerId, null);
  });

  test("the pass seats existing leads once, leaves decided seats, other leads and later stages alone", async () => {
    await designate(pritesh.email!);
    const mine = await makeProspect(seema.id);
    const theirs = await makeProspect(salesman.id);
    const other = await makeUser("Someone Else", "manager", [["crm", "manager"]]);
    const decided = await makeProspect(null, { leadManagerId: other.id, leadManagerDecidedAt: new Date() });
    const later = await makeProspect(seema.id, { leadStage: "sample_trial" });

    assert.equal(await ensureSelfRaisedVerifierSeats(), 1);
    assert.equal((await row(mine.id)).leadManagerId, pritesh.id);
    assert.equal((await row(theirs.id)).leadManagerId, null, "a Salesman's lead is not self-raised");
    assert.equal((await row(decided.id)).leadManagerId, other.id, "somebody chose that seat");
    assert.equal((await row(later.id)).leadManagerId, null, "past Qualification");

    assert.equal(await ensureSelfRaisedVerifierSeats(), 0, "a second pass finds nothing to change");
  });
});

/* ═══════════════════════════════════════════════ C — off by default */

describe("C: nothing changes until somebody is designated", () => {
  test("unset: the seat holder verifies as before, and no seat is written", async () => {
    const lead = await makeProspect(seema.id);
    assert.equal(await designatedApprover(), null);
    assert.equal(await ensureSelfRaisedVerifierSeats(), 0);
    assert.equal((await row(lead.id)).leadManagerId, null);
    asSeema();
    const v = await verify(lead.id);
    assert.equal(v.ok, true, v.ok ? "" : v.error);
  });

  test("a typo names nobody, so no lead is locked", async () => {
    await designate("pritesh.typo@nowhere.test");
    assert.equal(await designatedApprover(), null);
    const lead = await makeProspect(seema.id);
    assert.equal(await approverFor({ ownerId: lead.ownerId, salesManagerId: lead.salesManagerId }), null);
    asSeema();
    assert.equal((await verify(lead.id)).ok, true);
  });

  test("naming the Sales Manager herself designates nobody", async () => {
    await designate(seema.email!);
    const lead = await makeProspect(seema.id);
    assert.equal(await approverFor({ ownerId: lead.ownerId, salesManagerId: lead.salesManagerId }), null);
  });

  test("a deactivated person is nobody", async () => {
    await designate(pritesh.email!);
    await db.update(users).set({ active: false }).where(eq(users.id, pritesh.id));
    assert.equal(await designatedApprover(), null);
  });
});

/* ═══════════════════════════════════ D — a lead that is not self-raised */

describe("D: a Salesman's lead follows the ordinary rule, whoever is designated", () => {
  test("the Sales Manager still verifies, validates and reviews it", async () => {
    await designate(pritesh.email!);
    const lead = await makeProspect(salesman.id);
    asSeema();
    assert.equal((await verify(lead.id)).ok, true);

    asSalesman();
    const cols = qualificationColumns();
    assert.ok((await saveProspectFields(lead.id, { gstin: cols.gstin, application: cols.leadApplication, creditDaysWanted: 30, decisionMaker: "Ganesh" } as never)).ok);
    assert.ok((await saveLeadQualification(lead.id, { ...QUALIFICATION_ANSWERS })).ok);

    asSeema();
    assert.equal((await validateGstin({ customerId: lead.id, valid: true })).ok, true);
    assert.equal((await reviewLeadQualification({ customerId: lead.id, verdict: "verified" })).ok, true);
    assert.equal((await row(lead.id)).leadNextActionOwnerId, salesman.id);
  });

  test("and she still may not fill its Qualification — the Salesman who owns it does", async () => {
    await designate(pritesh.email!);
    const lead = await makeProspect(salesman.id);
    asSeema();
    assert.equal((await verify(lead.id)).ok, true);
    const own = await saveLeadQualification(lead.id, { trial_product: "PU Thinner" });
    assert.equal(own.ok, false);
    assert.match(!own.ok ? own.error : "", /Salesman who owns this lead completes/);
  });
});
