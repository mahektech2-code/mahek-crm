/**
 * A SALESMAN'S LEAD IS VERIFIED BY THE MANAGER ABOVE HIM ON THE ORG CHART.
 *
 *   1  Telecaller-created                      → the desk verifier (Pritesh)
 *   2  Sales Manager-created, incl. her own    → the desk verifier
 *   3  Salesman-created                        → the manager above THAT Salesman
 *   4  assigned to a Salesman now              → his hierarchy, whoever raised it
 *   5  creator unknown                         → the desk verifier, as a fallback
 *   6  the creator never verifies their lead
 *   7  routing never writes follow-up ownership
 *   8  qualification review is a separate question from designated verification
 *   9  holding `lead.verify` does not bypass the designated verifier
 *
 * Switched on by `leads.fieldVerifierByOrgChart`. The accounts are synthetic and
 * named for their jobs; nothing in the rule reads a name — identity is
 * `users.employee_id`, and the chart is `employee_reporting`.
 *
 * Real actions against `mahekone_test`.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  auditLog,
  customers,
  employeeReporting,
  employees,
  mbosDevices,
  mbosTasks,
  products,
  timelineEvents,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig, updateSetting } from "@/lib/config/store";
import { convertLeadToProspect, returnProspectRequest } from "@/lib/actions/lead-calling-desk";
import { verifyProspect } from "@/lib/actions/sales-manager-pipeline";
import { recordLeadValidationCall } from "@/lib/actions/leads";
import { assignDeskLead } from "@/lib/actions/lead-desk-assignment";
import { bulkReassignLeads, reassignLead } from "@/lib/actions/sales";
import { CRM_SALES_MANAGER_WORKSPACE } from "@/proxy";
import { setTestWorkspace } from "@/lib/services/crm-sales-manager-scope";
import { recomputeSalesManagers } from "@/lib/recompute";
import { canVerifyLeadById, fieldRouteFor, fieldSeatFor } from "@/lib/services/lead-verifier";
import { lineManagerFor } from "@/lib/services/lead-qualification-service";
import { verificationQueue } from "@/lib/services/lead-console-service";
import { captureLead } from "@/lib/actions/lead-intake";
import { QUAL_NEXT } from "@/lib/services/lead-qualification-flow-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type Level = "associate" | "manager" | "admin";
type U = typeof users.$inferSelect;

let tele: U; // Telecaller: CRM associate + the Calling desk
let pritesh: U; // the desk verifier: an administrator
let mira: U; // Sales Manager over Rakesh — CRM associate + the Sales Manager module
let seema: U; // Sales Manager over Mira and Dev
let rakesh: U; // Salesman, reports to Mira
let dev: U; // Salesman, reports to Seema
let productId: string;
const emp: Record<string, string> = {};

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

let rowNo = 100;
async function makeEmployee(key: string, over: Partial<typeof employees.$inferInsert> = {}) {
  rowNo += 1;
  const [e] = await db
    .insert(employees)
    .values({
      id: id("emp"),
      employeeCode: `ORG-${rowNo}`,
      name: `Employee ${key}`,
      status: "active",
      sheetStatus: "present",
      rowNumber: rowNo,
      raw: {},
      rowHash: `org-${rowNo}-${randomUUID()}`,
      ...over,
    })
    .returning();
  emp[key] = e.id;
  return e;
}
/** Narrow to one other screen: no module rows at all would mean EVERY module, the Sales Manager seat included. */
async function withoutSalesManagerModule(user: U) {
  await db.delete(appModuleAccess).where(eq(appModuleAccess.userId, user.id));
  await db.insert(appModuleAccess).values({ id: id("ama"), userId: user.id, app: "crm", module: "crm.leads" });
}
const linkAccount = (user: U, key: string) =>
  db.update(users).set({ employeeId: emp[key] }).where(eq(users.id, user.id));
const report = (who: string, to: string) =>
  db.insert(employeeReporting).values({ id: id("er"), employeeId: emp[who], managerId: emp[to] });

const setting = async (key: string, value: string | boolean) => {
  const r = await updateSetting(key as never, value as never, pritesh.id);
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r));
  invalidateConfig();
};
const configure = async () => {
  await setting("leads.telecallerVerifierEmail", pritesh.email!);
  await setting("leads.selfRaisedVerifierEmail", pritesh.email!);
  await setting("leads.fieldVerifierByOrgChart", true);
};

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];

async function makeLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [r] = await db
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
      leadDecisionMaker: "Owner",
      leadMonthlyVolumeLitres: 300,
      leadRequiredProductId: productId,
      leadCompetitor: "Local thinner",
      ...over,
    })
    .returning();
  return r;
}

async function raisedBy(leadId: string, by: U, how: "desk" | "handset", level: Level = "associate") {
  await db.insert(timelineEvents).values({
    id: id("tle"),
    customerId: leadId,
    eventType: "lead_created",
    sourceApp: how === "desk" ? "crm" : "mbos",
    sourceRecordId: leadId,
    occurredAt: new Date(),
    actorUserId: by.id,
    summary: "raised (fixture)",
  });
  if (how === "handset") {
    await db.insert(auditLog).values({
      id: id("aud"),
      actorId: by.id,
      action: "lead.captured",
      entityType: "customer",
      entityId: leadId,
      actorRole: level,
      actorApp: "field",
      beforeState: null,
      afterState: { channel: "handset" },
    });
  }
}

const route = async (leadId: string) => {
  const r = await row(leadId);
  return fieldRouteFor({ id: leadId, ownerId: r.ownerId });
};
const verifierOf = (r: Awaited<ReturnType<typeof route>>) => (r.kind === "verifier" ? r.id : null);

const convert = (customerId: string) =>
  convertLeadToProspect({ customerId, reasonCode: "regular_requirement", customerType: "manufacturer" });
const asTele = () => { setTestWorkspace(null); setTestUser(tele); };
const asPritesh = () => { setTestWorkspace(null); setTestUser(pritesh); };
const asSM = (u: U) => { setTestWorkspace(CRM_SALES_MANAGER_WORKSPACE); setTestUser(u); };

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
      mbos_devices, notifications, timeline_events, audit_log, app_module_access, app_access,
      mbos_user_territories, calls, employee_reporting, employees, customers, products, users, app_settings
      restart identity cascade`);
  invalidateConfig();
  await seedConfig();

  tele = await makeUser("Tara Telecaller", "associate", [["crm", "associate"]], ["crm.lead-calling-desk"]);
  pritesh = await makeUser("Pritesh Bipin Doshi", "admin", [["crm", "admin"], ["sales", "admin"], ["field", "admin"]]);
  mira = await makeUser("Mira Manager", "associate", [["crm", "associate"], ["sales", "associate"]], ["crm.sales-manager"]);
  seema = await makeUser("Seema Roy", "associate", [["crm", "associate"], ["sales", "associate"]], ["crm.sales-manager"]);
  rakesh = await makeUser("Rakesh Field", "associate", [["field", "associate"]]);
  dev = await makeUser("Dev Field", "associate", [["field", "associate"]]);
  await db.insert(mbosDevices).values({ id: id("dev"), userId: rakesh.id, deviceId: "dev-r", active: true });
  await db.insert(mbosDevices).values({ id: id("dev"), userId: dev.id, deviceId: "dev-d", active: true });
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });

  /* Rakesh → Mira → Seema → Pritesh;  Dev → Seema. */
  for (const k of ["rakesh", "dev", "mira", "seema", "pritesh", "tele"]) await makeEmployee(k);
  await linkAccount(tele, "tele");
  await report("tele", "pritesh");
  await linkAccount(rakesh, "rakesh");
  await linkAccount(dev, "dev");
  await linkAccount(mira, "mira");
  await linkAccount(seema, "seema");
  await linkAccount(pritesh, "pritesh");
  await report("rakesh", "mira");
  await report("mira", "seema");
  await report("seema", "pritesh");
  await report("dev", "seema");
});

/* ====================================================== rules 1 and 2: the desk */

describe("a desk lead is the desk verifier's — Pritesh — whatever the chart says above the creator", () => {
  test("1. a Telecaller's lead goes to Pritesh, even when her chart manager is somebody else", async () => {
    await configure();
    // Tara reports to Mira on this chart; the rule is still Pritesh.
    await db.update(employeeReporting).set({ managerId: emp.mira }).where(eq(employeeReporting.employeeId, emp.tele));
    const lead = await makeLead();
    await raisedBy(lead.id, tele, "desk");
    const r = await route(lead.id);
    assert.equal(verifierOf(r), pritesh.id);
    assert.equal(r.kind === "verifier" && r.reason, "desk");

    asTele();
    const c = await convert(lead.id);
    assert.equal(c.ok, true, c.ok ? "" : c.error);
    const after = await row(lead.id);
    assert.equal(after.leadManagerId, pritesh.id);
    assert.equal(after.ownerId, tele.id, "the Telecaller still follows it up: Pritesh verifies, he does not own");
  });

  test("2. a Sales Manager's own lead — Seema's included — goes to Pritesh", async () => {
    await configure();
    for (const sm of [mira, seema]) {
      const lead = await makeLead({ ownerId: null, salesManagerId: sm.id, salesManagerDecidedAt: new Date() });
      await raisedBy(lead.id, sm, "desk");
      assert.equal(verifierOf(await route(lead.id)), pritesh.id, `${sm.name}'s own lead`);
    }
  });

  test("2b. the desk verifier's own lead is HELD: nobody verifies their own, nobody is invented", async () => {
    await configure();
    const lead = await makeLead({ ownerId: null });
    await raisedBy(lead.id, pritesh, "desk");
    const r = await route(lead.id);
    assert.equal(r.kind, "refuse");
    assert.match(r.kind === "refuse" ? r.message : "", /raised it and is the desk verifier/);
    assert.match(r.kind === "refuse" ? r.message : "", /administrator must decide/);
    for (const u of [pritesh, mira, seema]) {
      assert.equal(await canVerifyLeadById(u, lead.id, { designated: true }), false, `${u.name}`);
    }
  });

  test("2c. Heena — top of the chart, not the desk verifier — has her leads verified by Pritesh", async () => {
    await configure();
    const heena = await makeUser("Heena Pritesh Doshi", "associate", [["crm", "associate"]], ["crm.lead-calling-desk"]);
    await makeEmployee("heena");
    await linkAccount(heena, "heena"); // no manager recorded: top of the chart
    const lead = await makeLead({ ownerId: heena.id });
    await raisedBy(lead.id, heena, "desk");
    assert.equal(verifierOf(await route(lead.id)), pritesh.id);
  });

  test("2d. no desk verifier configured: every desk lead is held in words", async () => {
    await setting("leads.fieldVerifierByOrgChart", true);
    const lead = await makeLead();
    await raisedBy(lead.id, tele, "desk");
    const r = await route(lead.id);
    assert.equal(r.kind, "refuse");
    assert.match(r.kind === "refuse" ? r.message : "", /no desk verifier is configured/);
  });
});

/* =============================================== rule 3: Salesman-created lead */

describe("3. a lead a Salesman raised goes to the manager above THAT Salesman", () => {
  test("Rakesh's lead is Mira's; Dev's is Seema's — nothing is one configured account", async () => {
    await configure();
    const a = await makeLead({ ownerId: tele.id });
    await raisedBy(a.id, rakesh, "handset", "associate");
    const b = await makeLead({ ownerId: tele.id });
    await raisedBy(b.id, dev, "handset", "associate");

    const ra = await route(a.id);
    const rb = await route(b.id);
    assert.equal(verifierOf(ra), mira.id);
    assert.equal(ra.kind === "verifier" && ra.reason, "salesman_created");
    assert.equal(verifierOf(rb), seema.id);
  });

  test("a Telecaller converting it seats Mira and the Telecaller keeps ownership", async () => {
    await configure();
    const lead = await makeLead({ ownerId: tele.id });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    asTele();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadManagerId, mira.id);
    assert.equal(after.leadNextActionOwnerId, mira.id);
    assert.equal(after.ownerId, tele.id);
  });
});

/* ================================================ rule 4: assignment overrides */

describe("4. the assigned Salesman's hierarchy comes first, whoever raised it", () => {
  test("a lead Dev raised, now held by Rakesh, is Mira's", async () => {
    await configure();
    const lead = await makeLead({ ownerId: rakesh.id });
    await raisedBy(lead.id, dev, "handset", "associate");
    assert.equal(verifierOf(await route(lead.id)), mira.id);
  });

  test("a Telecaller's lead given to Dev is Seema's, and it is seated by the nightly pass", async () => {
    await configure();
    const lead = await makeLead({ ownerId: dev.id });
    await raisedBy(lead.id, tele, "desk");
    const r = await route(lead.id);
    assert.equal(verifierOf(r), seema.id);
    assert.equal(r.kind === "verifier" && r.reason, "assigned");

    await recomputeSalesManagers();
    assert.equal((await row(lead.id)).salesManagerId, seema.id);
  });
});

/* ============================================ the chain: levels and eligibility */

describe("the reporting chain", () => {
  test("a multi-level chain: Mira cannot verify, so Seema does", async () => {
    await configure();
    await withoutSalesManagerModule(mira);
    const lead = await makeLead({ ownerId: rakesh.id });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    assert.equal(verifierOf(await route(lead.id)), seema.id);
  });

  test("an inactive immediate manager is passed over", async () => {
    await configure();
    await db.update(users).set({ active: false }).where(eq(users.id, mira.id));
    const lead = await makeLead({ ownerId: rakesh.id });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    assert.equal(verifierOf(await route(lead.id)), seema.id);
  });

  test("a leaver is passed over", async () => {
    await configure();
    await db.update(employees).set({ status: "inactive" }).where(eq(employees.id, emp.mira));
    const lead = await makeLead({ ownerId: rakesh.id });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    assert.equal(verifierOf(await route(lead.id)), seema.id);
  });

  test("an employee withdrawn from the sheet is passed over", async () => {
    await configure();
    await db.update(employees).set({ sheetStatus: "withdrawn" }).where(eq(employees.id, emp.mira));
    const lead = await makeLead({ ownerId: rakesh.id });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    assert.equal(verifierOf(await route(lead.id)), seema.id);
  });

  test("a changed manager changes the verifier, and the seat follows", async () => {
    await configure();
    const lead = await makeLead({ ownerId: rakesh.id });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    assert.equal(verifierOf(await route(lead.id)), mira.id);

    await db.update(employeeReporting).set({ managerId: emp.seema }).where(eq(employeeReporting.employeeId, emp.rakesh));
    assert.equal(verifierOf(await route(lead.id)), seema.id);
    await recomputeSalesManagers();
    assert.equal((await row(lead.id)).salesManagerId, seema.id);
  });
});

describe("a chart that cannot be trusted refuses — nobody is substituted", () => {
  const cannot = /Nobody can verify this lead yet/;

  test("the Salesman's account names no employee", async () => {
    await configure();
    await db.update(users).set({ employeeId: null }).where(eq(users.id, rakesh.id));
    const lead = await makeLead({ ownerId: rakesh.id, salesManagerId: seema.id });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    const r = await route(lead.id);
    assert.equal(r.kind, "refuse");
    assert.match(r.kind === "refuse" ? r.message : "", cannot);

    await recomputeSalesManagers();
    assert.equal((await row(lead.id)).salesManagerId, seema.id, "the seat was left, not rewritten");
  });

  test("nobody is recorded above him", async () => {
    await configure();
    await db.delete(employeeReporting).where(eq(employeeReporting.employeeId, emp.rakesh));
    const lead = await makeLead({ ownerId: rakesh.id });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    assert.equal((await route(lead.id)).kind, "refuse");
  });

  test("a reporting loop above him", async () => {
    await configure();
    await db.update(employeeReporting).set({ managerId: emp.mira }).where(eq(employeeReporting.employeeId, emp.seema));
    await withoutSalesManagerModule(mira);
    await withoutSalesManagerModule(seema);
    const lead = await makeLead({ ownerId: rakesh.id });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    assert.equal((await route(lead.id)).kind, "refuse");
  });

  test("nobody on the chain can verify", async () => {
    await configure();
    await withoutSalesManagerModule(mira);
    await withoutSalesManagerModule(seema);
    await db.update(users).set({ active: false }).where(eq(users.id, pritesh.id));
    const lead = await makeLead({ ownerId: rakesh.id });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    const r = await route(lead.id);
    assert.equal(r.kind, "refuse");

    asTele();
    const c = await convert(lead.id);
    assert.equal(c.ok, false, "the conversion is refused, not rerouted");
  });

  test("two Salesmen on one chart: one resolves and one refuses, independently", async () => {
    await configure();
    await db.delete(employeeReporting).where(eq(employeeReporting.employeeId, emp.dev));
    const a = await makeLead({ ownerId: rakesh.id });
    await raisedBy(a.id, rakesh, "handset", "associate");
    const b = await makeLead({ ownerId: dev.id });
    await raisedBy(b.id, dev, "handset", "associate");
    const seats = await fieldSeatFor([
      { id: a.id, ownerId: rakesh.id },
      { id: b.id, ownerId: dev.id },
    ]);
    assert.equal(seats.approvers.get(a.id), mira.id);
    assert.equal(seats.approvers.has(b.id), false);
    assert.equal(seats.unresolved.has(b.id), true);
  });
});

/* ======================================================= rule 5: unknown creator */

describe("5. an unknown creator goes to the configured desk verifier", () => {
  test("a lead with no creator record, no Salesman: Pritesh, as a fallback", async () => {
    await configure();
    const lead = await makeLead({ ownerId: tele.id });
    const r = await route(lead.id);
    assert.equal(r.kind, "fallback");
    assert.equal(r.kind === "fallback" && r.id, pritesh.id);
  });

  test("with the desk verifier unusable it is refused in words, never rerouted", async () => {
    await configure();
    await db.update(users).set({ active: false }).where(eq(users.id, pritesh.id));
    const lead = await makeLead({ ownerId: tele.id });
    const r = await route(lead.id);
    assert.notEqual(r.kind, "verifier");
    assert.notEqual(r.kind, "fallback");
  });
});

/* ===================================================== rule 6: never their own */

describe("6. a verifier never verifies their own lead", () => {
  test("a lead Mira raised and a Salesman under her now holds goes to the desk verifier", async () => {
    await configure();
    const lead = await makeLead({ ownerId: rakesh.id });
    await raisedBy(lead.id, mira, "desk");
    const r = await route(lead.id);
    assert.equal(r.kind, "verifier");
    assert.equal(r.kind === "verifier" && r.id, pritesh.id);
    assert.equal(r.kind === "verifier" && r.reason, "own_lead");

    asSM(mira);
    assert.equal(await canVerifyLeadById(mira, lead.id, { designated: true }), false);
  });

  test("the converter is never the verifier", async () => {
    await configure();
    const lead = await makeLead({ ownerId: rakesh.id });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    const r = await fieldRouteFor({ id: lead.id, ownerId: rakesh.id }, mira.id);
    assert.equal(r.kind, "refuse");
  });
});

/* ================================================ rule 7: follow-up ownership */

describe("7. routing never changes who follows a lead up", () => {
  test("the direct-conversion verification action is one the realignment recognises", () => {
    assert.equal(QUAL_NEXT.verify, "Sales Manager verification call");
  });

  test("giving a lead to Rakesh moves the seat and the verification call, never the owner or another next action", async () => {
    await configure();
    // Desk verifier holds the seat; the next action is somebody's own follow-up.
    const lead = await makeLead({
      ownerId: null,
      leadManagerId: pritesh.id,
      leadNextAction: "Collect the spec sheet",
      leadNextActionOwnerId: pritesh.id,
    });
    await raisedBy(lead.id, tele, "desk");

    asPritesh();
    const r = await reassignLead({ leadId: lead.id, salesmanId: rakesh.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.ownerId, rakesh.id, "the owner is what the caller asked for, nothing else");
    assert.equal(after.leadNextAction, "Collect the spec sheet");
    assert.equal(after.leadNextActionOwnerId, pritesh.id, "a follow-up is not a verification call");
  });

  test("the verification call itself does move with the seat", async () => {
    await configure();
    const lead = await makeLead({
      ownerId: null,
      leadManagerId: pritesh.id,
      leadNextAction: "Sales manager verification",
      leadNextActionOwnerId: pritesh.id,
      prospectRequestState: "awaiting",
      prospectRequestedAt: new Date(),
      prospectRequestedById: tele.id,
      prospectRequestReason: "regular_requirement",
    });
    await raisedBy(lead.id, tele, "desk");
    await db.insert(mbosTasks).values({
      id: id("task"), title: "Validation call", assignedToUserId: pritesh.id, assignedByUserId: tele.id,
      priority: "high", dueDate: "2026-12-01", customerId: lead.id, status: "open",
      sourceType: "lead_validation", sourceId: lead.id, createdById: tele.id, updatedById: tele.id,
    });

    asPritesh();
    const r = await reassignLead({ leadId: lead.id, salesmanId: rakesh.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.ownerId, rakesh.id);
    assert.equal(after.leadManagerId, mira.id);
    assert.equal(after.leadNextActionOwnerId, mira.id);
    const [task] = await db.select().from(mbosTasks).where(eq(mbosTasks.customerId, lead.id));
    assert.equal(task.assignedToUserId, mira.id);

    const back = await assignDeskLead({ customerId: lead.id, ownerId: tele.id });
    assert.equal(back.ok, true, back.ok ? "" : back.error);
    assert.equal((await row(lead.id)).ownerId, tele.id);
  });
});

/* ======================================= rules 8 and 9: who may do what to it */

describe("8 and 9. only the designated verifier verifies; review stays separate", () => {
  const answers = { visited: "Yes", explained: "Yes", genuine_interest: "Yes", ready_for_trial: "Yes" };

  async function prospectUnder(salesman: U) {
    const lead = await makeLead({
      ownerId: salesman.id,
      /* The seat the nightly pass / the handset capture would have written. */
      salesManagerId: mira.id,
      leadStage: "prospect",
      customerType: "retailer" as never,
    });
    await raisedBy(lead.id, salesman, "handset", "associate");
    return lead;
  }

  test("an administrator holding lead.verify is refused the verification; the designated manager is not", async () => {
    await configure();
    const lead = await prospectUnder(rakesh);

    asPritesh();
    const refused = await verifyProspect({ customerId: lead.id, outcome: "verified", answers, corrections: [] });
    assert.equal(refused.ok, false);
    assert.equal((await row(lead.id)).leadVerifiedAt, null);

    asSM(mira);
    const ok = await verifyProspect({ customerId: lead.id, outcome: "verified", answers, corrections: [] });
    assert.equal(ok.ok, true, ok.ok ? "" : ok.error);
    assert.notEqual((await row(lead.id)).leadVerifiedAt, null);
  });

  test("the verification call (the leads screen's door) enforces the same decision", async () => {
    await configure();
    const lead = await prospectUnder(rakesh);
    asPritesh();
    const refused = await recordLeadValidationCall(lead.id, { answers: {}, outcome: "verified" });
    assert.equal(refused.ok, false);
    assert.notEqual(refused.ok ? "" : refused.error, "");
    assert.equal((await row(lead.id)).leadVerifiedAt, null);
  });

  test("review permission is a different question: the administrator still reviews, but is not designated", async () => {
    await configure();
    const lead = await prospectUnder(rakesh);
    assert.equal(await canVerifyLeadById(pritesh, lead.id), true, "review keeps its own rule");
    assert.equal(await canVerifyLeadById(pritesh, lead.id, { designated: true }), false);
    assert.equal(await canVerifyLeadById(mira, lead.id, { designated: true }), true);
  });

  test("with the switch off, nothing about verification changes", async () => {
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    const lead = await prospectUnder(rakesh);
    assert.equal(await canVerifyLeadById(pritesh, lead.id, { designated: true }), true);
    assert.equal((await route(lead.id)).kind, "off");
  });
});

/* ============================ a change of owner leaves nothing stale behind it */

describe("a change of owner corrects the designation in the same commit", () => {
  /** A lead Rakesh holds (raised at the desk, so it is his hierarchy's only while he holds it), seated under Mira, with the verification call open on her. */
  async function underMira(raiser: U = tele, how: "desk" | "handset" = "desk") {
    const lead = await makeLead({
      ownerId: rakesh.id,
      salesManagerId: mira.id,
      leadManagerId: mira.id,
      leadNextAction: "Sales manager verification",
      leadNextActionOwnerId: mira.id,
      prospectRequestState: "awaiting",
      prospectRequestedAt: new Date(),
      prospectRequestedById: tele.id,
      prospectRequestReason: "regular_requirement",
    });
    await raisedBy(lead.id, raiser, how, "associate");
    await db.insert(mbosTasks).values({
      id: id("task"), title: "Validation call", assignedToUserId: mira.id, assignedByUserId: tele.id,
      priority: "high", dueDate: "2026-12-01", customerId: lead.id, status: "open",
      sourceType: "lead_validation", sourceId: lead.id, createdById: tele.id, updatedById: tele.id,
    });
    return lead;
  }
  const canDo = async (u: U, leadId: string) => canVerifyLeadById(u, leadId, { designated: true });

  test("to a different Salesman: the seat, the call and the permission all move to his manager", async () => {
    await configure();
    const lead = await underMira();
    assert.equal(await canDo(mira, lead.id), true);

    asPritesh();
    const r = await reassignLead({ leadId: lead.id, salesmanId: dev.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const after = await row(lead.id);
    assert.equal(after.ownerId, dev.id);
    assert.equal(after.salesManagerId, seema.id);
    assert.equal(after.leadManagerId, seema.id);
    assert.equal(after.leadNextActionOwnerId, seema.id);
    const [task] = await db.select().from(mbosTasks).where(eq(mbosTasks.customerId, lead.id));
    assert.equal(task.assignedToUserId, seema.id);
    assert.equal(await canDo(mira, lead.id), false, "the previous verifier is no longer able to");
    assert.equal(await canDo(seema, lead.id), true);
  });

  test("to somebody who is not a Salesman: the chart's seat is taken back, and the desk verifier has it", async () => {
    await configure();
    const lead = await underMira();

    asPritesh();
    const r = await assignDeskLead({ customerId: lead.id, ownerId: tele.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const after = await row(lead.id);
    assert.equal(after.ownerId, tele.id, "the owner is exactly who was asked for");
    assert.notEqual(after.salesManagerId, mira.id, "the stale Sales Manager seat is gone at once");
    assert.equal(after.leadManagerId, pritesh.id);
    assert.equal(after.leadNextActionOwnerId, pritesh.id);
    // Mira held the seat a moment ago: neither the seat nor the capability remains.
    assert.equal(await canDo(mira, lead.id), false);
    assert.equal(await canVerifyLeadById(mira, lead.id), false, "not even by the old seat");
  });

  test("to a Salesman the chart cannot place: nobody is seated, the old holder is cleared, and nobody may verify", async () => {
    await configure();
    await db.delete(employeeReporting).where(eq(employeeReporting.employeeId, emp.dev));
    const lead = await underMira();

    asPritesh();
    const r = await reassignLead({ leadId: lead.id, salesmanId: dev.id });
    assert.equal(r.ok, true, "the move itself commits");
    assert.match(r.ok && typeof r.message === "string" ? r.message : "", /not moved|verification seat|Nobody/i);

    const after = await row(lead.id);
    assert.equal(after.ownerId, dev.id);
    assert.equal(after.salesManagerId, null, "no chart manager is left holding the seat");
    assert.equal(after.leadNextAction, "Sales manager verification", "the next action itself is not rewritten");
    for (const u of [mira, seema, pritesh]) {
      assert.equal(await canDo(u, lead.id), false, `${u.name} is refused: the chart names nobody`);
    }
  });

  test("an ordinary next action is never moved by any of it", async () => {
    await configure();
    const lead = await makeLead({
      ownerId: rakesh.id,
      salesManagerId: mira.id,
      leadManagerId: mira.id,
      leadNextAction: "Send the price list",
      leadNextActionOwnerId: mira.id,
    });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    asPritesh();
    const r = await reassignLead({ leadId: lead.id, salesmanId: dev.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadNextAction, "Send the price list");
    assert.equal(after.leadNextActionOwnerId, mira.id);
    assert.equal(after.ownerId, dev.id);
  });
});

describe("the old field-verifier setting is ignored in org-chart mode — on purpose", () => {
  test("naming somebody else there changes nothing", async () => {
    await configure();
    const bystander = await makeUser("Bina Bystander", "manager", [["crm", "manager"]]);
    await setting("leads.fieldVerifierEmail", bystander.email!);
    const lead = await makeLead({ ownerId: rakesh.id });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    assert.equal(verifierOf(await route(lead.id)), mira.id);
  });

  test("a self-link in the chart is refused, not followed", async () => {
    await configure();
    await db.update(employeeReporting).set({ managerId: emp.rakesh }).where(eq(employeeReporting.employeeId, emp.rakesh));
    const lead = await makeLead({ ownerId: rakesh.id });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    assert.equal((await route(lead.id)).kind, "refuse");
  });

  test("two Salesmen with the same display name are told apart by the employee link", async () => {
    await configure();
    await db.update(users).set({ name: "Rakesh Field" }).where(eq(users.id, dev.id));
    const a = await makeLead({ ownerId: rakesh.id });
    await raisedBy(a.id, rakesh, "handset", "associate");
    const b = await makeLead({ ownerId: dev.id });
    await raisedBy(b.id, dev, "handset", "associate");
    assert.equal(verifierOf(await route(a.id)), mira.id);
    assert.equal(verifierOf(await route(b.id)), seema.id);
  });
});

/* ============ resolved → unresolved → resolved, with no ownership change at all */

describe("the chart is edited in HRMS: queue, call and permission follow it", () => {
  async function leadUnderMira() {
    const lead = await makeLead({
      ownerId: rakesh.id,
      salesManagerId: mira.id,
      leadManagerId: mira.id,
      leadNextAction: "Sales manager verification",
      leadNextActionOwnerId: mira.id,
      leadNextActionOutcome: "Verify what the calling desk collected, then confirm the Prospect",
      prospectRequestState: "awaiting",
      prospectRequestedAt: new Date(),
      prospectRequestedById: tele.id,
      prospectRequestReason: "regular_requirement",
    });
    await raisedBy(lead.id, tele, "desk");
    await db.insert(mbosTasks).values({
      id: id("task"), title: "Validation call", assignedToUserId: mira.id, assignedByUserId: tele.id,
      priority: "high", dueDate: "2026-12-01", customerId: lead.id, status: "open",
      sourceType: "lead_validation", sourceId: lead.id, createdById: tele.id, updatedById: tele.id,
    });
    return lead;
  }
  const taskOf = async (leadId: string) =>
    (await db.select().from(mbosTasks).where(eq(mbosTasks.customerId, leadId)))[0];
  const canDo = (u: U, leadId: string) => canVerifyLeadById(u, leadId, { designated: true });

  test("breaks, then is repaired, then moves — each step is the same decision everywhere", async () => {
    await configure();
    const lead = await leadUnderMira();
    assert.equal(await canDo(mira, lead.id), true);

    // 1. The chart loses Rakesh's reporting line.
    await db.delete(employeeReporting).where(eq(employeeReporting.employeeId, emp.rakesh));
    await recomputeSalesManagers();

    let l = await row(lead.id);
    assert.equal(l.ownerId, rakesh.id, "ownership is not touched");
    assert.equal(l.salesManagerId, mira.id, "the scheduled pass never takes a manager's sight of a lead away");
    assert.equal(l.leadManagerId, null, "but the verification is no longer shown as theirs to do");
    assert.equal(l.leadNextAction, "Sales manager verification", "the action is not rewritten");
    assert.equal(l.leadNextActionOwnerId, null);
    assert.match(l.leadNextActionOutcome ?? "", /^Verification is blocked:/, "and it says why");
    let t = await taskOf(lead.id);
    assert.equal(t.status, "cancelled", "the call is closed, not deleted");
    assert.match(t.completionNote ?? "", /^Verification is blocked:/);
    for (const u of [mira, seema, pritesh]) {
      assert.equal(await canDo(u, lead.id), false, `${u.name}: refused while unresolved`);
    }
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, lead.id));
    assert.ok(audits.some((a) => a.action === "lead.verifier.blocked"), "the history records it");

    // 2. Repaired: the same call is re-opened for the manager the chart now names.
    await report("rakesh", "mira");
    await recomputeSalesManagers();
    l = await row(lead.id);
    assert.equal(l.salesManagerId, mira.id);
    assert.equal(l.leadManagerId, mira.id);
    assert.equal(l.leadNextActionOwnerId, mira.id);
    assert.equal(l.leadNextActionOutcome, null, "the blocked sentence is taken off");
    t = await taskOf(lead.id);
    assert.equal(t.status, "open");
    assert.equal(t.assignedToUserId, mira.id);
    assert.equal(await canDo(mira, lead.id), true);
    assert.equal(l.ownerId, rakesh.id);

    // 3. HR moves him under Seema: everything follows in the same pass.
    await db.update(employeeReporting).set({ managerId: emp.seema }).where(eq(employeeReporting.employeeId, emp.rakesh));
    await recomputeSalesManagers();
    l = await row(lead.id);
    assert.equal(l.salesManagerId, seema.id);
    assert.equal(l.leadManagerId, seema.id);
    assert.equal(l.leadNextActionOwnerId, seema.id);
    assert.equal((await taskOf(lead.id)).assignedToUserId, seema.id);
    assert.equal(await canDo(mira, lead.id), false);
    assert.equal(await canDo(seema, lead.id), true);
    assert.equal((await row(lead.id)).ownerId, rakesh.id);
  });

  test("an ordinary follow-up on the lead is not touched by a blocked verification", async () => {
    await configure();
    const lead = await makeLead({
      ownerId: rakesh.id,
      salesManagerId: mira.id,
      leadManagerId: mira.id,
      leadNextAction: "Send the price list",
      leadNextActionOwnerId: mira.id,
      leadNextActionOutcome: "They asked for the 20 litre rate",
    });
    await raisedBy(lead.id, tele, "desk");
    await db.delete(employeeReporting).where(eq(employeeReporting.employeeId, emp.rakesh));
    await recomputeSalesManagers();
    const l = await row(lead.id);
    assert.equal(l.leadNextAction, "Send the price list");
    assert.equal(l.leadNextActionOwnerId, mira.id);
    assert.equal(l.leadNextActionOutcome, "They asked for the 20 litre rate");
    assert.equal(l.ownerId, rakesh.id);
  });
});

/* ============================== the gate is the same for every route it names */

describe("nobody but the named verifier, on every org-mode answer", () => {
  test("a Salesman's lead its own manager raised goes to the desk verifier — and only to him", async () => {
    await configure();
    const mgr = await makeUser("Manoj Manager", "manager", [["crm", "manager"]]);
    const lead = await makeLead({ ownerId: rakesh.id, leadStage: "prospect", salesManagerId: mira.id });
    await raisedBy(lead.id, mira, "desk");
    const r = await route(lead.id);
    assert.equal(r.kind === "verifier" && r.id, pritesh.id);
    assert.equal(await canVerifyLeadById(pritesh, lead.id, { designated: true }), true);
    assert.equal(await canVerifyLeadById(mgr, lead.id, { designated: true }), false, "lead.verify is not enough");
    assert.equal(await canVerifyLeadById(mira, lead.id, { designated: true }), false, "and not their own");
  });

  test("when the desk verifier is also the creator and the first manager, nobody is named", async () => {
    await configure();
    await db.update(employeeReporting).set({ managerId: emp.pritesh }).where(eq(employeeReporting.employeeId, emp.rakesh));
    const lead = await makeLead({ ownerId: rakesh.id, leadStage: "prospect" });
    await raisedBy(lead.id, pritesh, "desk");
    const r = await route(lead.id);
    assert.equal(r.kind, "refuse");
    for (const u of [pritesh, mira, seema]) {
      assert.equal(await canVerifyLeadById(u, lead.id, { designated: true }), false);
    }
  });

  test("sending a request back is refused to anyone the chart did not designate", async () => {
    await configure();
    /* Sending back needs the manager-level capability, so the designated person
       here is a manager: Rakesh now reports to Manoj, who holds `lead.verify`. */
    const manoj = await makeUser("Manoj Manager", "manager", [["crm", "manager"]]);
    await makeEmployee("manoj");
    await linkAccount(manoj, "manoj");
    await db.update(employeeReporting).set({ managerId: emp.manoj }).where(eq(employeeReporting.employeeId, emp.rakesh));
    const lead = await makeLead({
      ownerId: rakesh.id,
      leadManagerId: manoj.id,
      prospectRequestState: "awaiting",
      prospectRequestedAt: new Date(),
      prospectRequestedById: tele.id,
      prospectRequestReason: "regular_requirement",
    });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    asPritesh();
    const refused = await returnProspectRequest({ customerId: lead.id, note: "Not enough detail." });
    assert.equal(refused.ok, false, "an administrator holding lead.verify is not the designated verifier");
    assert.equal((await row(lead.id)).prospectRequestState, "awaiting");
    setTestWorkspace(null);
    setTestUser(manoj);
    const ok = await returnProspectRequest({ customerId: lead.id, note: "Not enough detail." });
    assert.equal(ok.ok, true, ok.ok ? "" : ok.error);
  });
});

describe("with the switch off, the nightly pass does not touch the coordinating seat", () => {
  test("a stale coordinating seat on a Salesman's lead is left exactly as it was", async () => {
    await setting("leads.fieldVerifierEmail", mira.email!);
    const lead = await makeLead({
      ownerId: rakesh.id,
      leadManagerId: tele.id,
      leadNextAction: "Sales manager verification",
      leadNextActionOwnerId: tele.id,
    });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    await recomputeSalesManagers();
    const l = await row(lead.id);
    assert.equal(l.leadManagerId, tele.id);
    assert.equal(l.leadNextActionOwnerId, tele.id);
    assert.equal(l.salesManagerId, mira.id, "the Sales Manager seat is the old pass's, and still is");
  });
});

/* ===================== problem 5: both reassignment doors treat a follow-up alike */

describe("a follow-up owed by the old owner follows the lead through either door", () => {
  const two = async () => {
    const make = () =>
      makeLead({
        ownerId: tele.id,
        leadNextAction: "Call back about the rate",
        leadNextActionOwnerId: tele.id,
      });
    const a = await make();
    const b = await make();
    const c = await makeLead({
      ownerId: tele.id,
      leadNextAction: "Manager review",
      leadNextActionOwnerId: pritesh.id,
    });
    for (const l of [a, b, c]) await raisedBy(l.id, tele, "desk");
    return { a, b, c };
  };

  test("single reassignment", async () => {
    await configure();
    const { a, c } = await two();
    asPritesh();
    assert.equal((await reassignLead({ leadId: a.id, salesmanId: rakesh.id })).ok, true);
    assert.equal((await row(a.id)).leadNextActionOwnerId, rakesh.id, "the call-back goes with the lead");
    assert.equal((await reassignLead({ leadId: c.id, salesmanId: rakesh.id })).ok, true);
    assert.equal((await row(c.id)).leadNextActionOwnerId, pritesh.id, "somebody else's action stays theirs");
  });

  test("bulk reassignment does the same, and leaves a next action owed to somebody else alone", async () => {
    await configure();
    const { a, b, c } = await two();
    asPritesh();
    const r = await bulkReassignLeads({ leadIds: [a.id, b.id, c.id], salesmanId: rakesh.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(a.id)).leadNextActionOwnerId, rakesh.id);
    assert.equal((await row(b.id)).leadNextActionOwnerId, rakesh.id);
    assert.equal((await row(c.id)).leadNextActionOwnerId, pritesh.id, "owed to Pritesh, not to the previous owner");
    assert.equal((await row(c.id)).ownerId, rakesh.id, "the lead itself moved");
  });
});


/* ========================= exclusive verification, identity, sight and held leads */

describe("A. a creator nobody can name is the desk verifier's, and nobody else's", () => {
  test("a lead with no creator record cannot be verified by an administrator or any lead.verify holder", async () => {
    await configure();
    const manoj = await makeUser("Manoj Manager", "manager", [["crm", "manager"]]);
    const lead = await makeLead({ ownerId: tele.id, leadStage: "prospect" });
    assert.equal(await canVerifyLeadById(manoj, lead.id, { designated: true }), false);
    assert.equal(await canVerifyLeadById(mira, lead.id, { designated: true }), false);
    assert.equal(await canVerifyLeadById(pritesh, lead.id, { designated: true }), true, "the configured fallback");
  });

  test("with the fallback unusable it fails closed for everybody, with the reason", async () => {
    await configure();
    await db.update(users).set({ active: false }).where(eq(users.id, pritesh.id));
    const manoj = await makeUser("Manoj Manager", "manager", [["crm", "manager"]]);
    const lead = await makeLead({ ownerId: tele.id, leadStage: "prospect" });
    assert.equal((await route(lead.id)).kind, "refuse");
    assert.equal(await canVerifyLeadById(manoj, lead.id, { designated: true }), false);
    asPritesh();
    const r = await recordLeadValidationCall(lead.id, { answers: {}, outcome: "verified" });
    assert.equal(r.ok, false);
  });
});

describe("B. a person is found by employee link, never by display name", () => {
  test("a decoy employee with the Telecaller's exact name does not decide her lead's seat", async () => {
    await configure();
    // A different person on the chart carries Tara's exact name and answers to Mira.
    const [decoy] = await db
      .insert(employees)
      .values({
        id: id("emp"), employeeCode: "DECOY-1", name: tele.name, status: "active", sheetStatus: "present",
        rowNumber: 900, raw: {}, rowHash: `decoy-${randomUUID()}`,
      })
      .returning();
    await db.insert(employeeReporting).values({ id: id("er"), employeeId: decoy.id, managerId: emp.mira });
    const lead = await makeLead({ ownerId: tele.id, salesManagerId: null });
    await raisedBy(lead.id, tele, "desk");

    await recomputeSalesManagers();
    assert.equal((await row(lead.id)).salesManagerId, pritesh.id, "Tara's OWN manager by employee id, not the namesake's");
  });

  test("the qualification line manager is the chart manager by employee id", async () => {
    await configure();
    assert.equal(await lineManagerFor(rakesh.id), mira.id);
    await db.update(users).set({ employeeId: null }).where(eq(users.id, rakesh.id));
    assert.equal(await lineManagerFor(rakesh.id), null, "unlinked: nobody is guessed from the name");
  });
});

describe("C. the right Sales Manager sees a lead at once, and held leads are findable", () => {
  test("a Telecaller's new lead is seated under her chart manager in the same write", async () => {
    await configure();
    asTele();
    const made = await captureLead({
      salesType: "direct", name: "Instant Paints", phone: "9876543210", city: "Nashik", source: "telecalling",
    } as never);
    assert.ok(made.ok, made.ok ? "" : made.error);
    const lead = await row(made.data.customerId);
    assert.equal(lead.salesManagerId, pritesh.id, "no nightly pass was run");
    assert.equal(lead.salesManagerDecidedAt, null, "the chart still owns the seat");
  });

  test("a person with no place on the chart creates a lead that is seated nowhere - and is not guessed", async () => {
    await configure();
    const stranger = await makeUser("Sam Stranger", "associate", [["crm", "associate"]], ["crm.lead-calling-desk"]);
    setTestWorkspace(null);
    setTestUser(stranger);
    const made = await captureLead({
      salesType: "direct", name: "Stray Paints", phone: "9876500011", city: "Nashik", source: "telecalling",
    } as never);
    assert.ok(made.ok, made.ok ? "" : made.error);
    assert.equal((await row(made.data.customerId)).salesManagerId, null);
  });

  test("reassignment and the nightly pass agree on the seat", async () => {
    await configure();
    const lead = await makeLead({ ownerId: tele.id, salesManagerId: null });
    await raisedBy(lead.id, tele, "desk");
    asPritesh();
    assert.equal((await reassignLead({ leadId: lead.id, salesmanId: dev.id })).ok, true);
    const afterMove = (await row(lead.id)).salesManagerId;
    assert.equal(afterMove, seema.id);
    await recomputeSalesManagers();
    assert.equal((await row(lead.id)).salesManagerId, afterMove, "the nightly pass changes nothing");
  });

  test("a held lead shows up in the verification queue with the reason", async () => {
    await configure();
    await db.delete(employeeReporting).where(eq(employeeReporting.employeeId, emp.rakesh));
    const lead = await makeLead({
      ownerId: rakesh.id,
      leadStage: "prospect",
      leadManagerId: mira.id,
      leadNextAction: "Sales manager verification",
      leadNextActionOwnerId: mira.id,
      leadNextActionOutcome: "Verify what the calling desk collected, then confirm the Prospect",
    });
    await raisedBy(lead.id, rakesh, "handset", "associate");
    await recomputeSalesManagers();
    asPritesh();
    const queue = await verificationQueue("2026-10-15", { limit: 100 });
    const held = queue.rows.find((r) => r.customerId === lead.id);
    assert.ok(held, "the held lead is on the list, not silently dropped");
    assert.equal(held?.leadManagerId, null);
    assert.match(held?.heldReason ?? "", /Nobody can verify this lead yet/);
  });
});

/* ===================== the switch OFF: reassignment and realignment as they were */

describe("with leads.fieldVerifierByOrgChart OFF, reassignment is exactly what it was", () => {
  const owedByTele = async () => {
    const lead = await makeLead({
      ownerId: tele.id,
      leadNextAction: "Call back about the rate",
      leadNextActionOwnerId: tele.id,
    });
    await raisedBy(lead.id, tele, "desk");
    return lead;
  };

  test("single reassignment leaves the next action with the previous owner", async () => {
    const lead = await owedByTele();
    asPritesh();
    assert.equal((await reassignLead({ leadId: lead.id, salesmanId: rakesh.id })).ok, true);
    const l = await row(lead.id);
    assert.equal(l.ownerId, rakesh.id);
    assert.equal(l.leadNextActionOwnerId, tele.id, "OFF: the old door never moved it");
  });

  test("bulk reassignment does the same", async () => {
    const a = await owedByTele();
    const b = await owedByTele();
    asPritesh();
    const r = await bulkReassignLeads({ leadIds: [a.id, b.id], salesmanId: rakesh.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(a.id)).leadNextActionOwnerId, tele.id);
    assert.equal((await row(b.id)).leadNextActionOwnerId, tele.id);
  });

  test("the realignment still moves a next action owed by the seat holder, as it always did", async () => {
    // The old field-verifier mode (a named person), not org-chart mode.
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    await setting("leads.selfRaisedVerifierEmail", pritesh.email!);
    await setting("leads.fieldVerifierEmail", mira.email!);
    const lead = await makeLead({
      ownerId: null,
      leadManagerId: pritesh.id,
      leadNextAction: "Collect the spec sheet",
      leadNextActionOwnerId: pritesh.id,
    });
    await raisedBy(lead.id, tele, "desk");
    asPritesh();
    assert.equal((await reassignLead({ leadId: lead.id, salesmanId: rakesh.id })).ok, true);
    const l = await row(lead.id);
    assert.equal(l.leadManagerId, mira.id);
    assert.equal(l.leadNextActionOwnerId, l.leadManagerId, "OFF: it follows the seat, as before");
  });

  test("with it ON the same move leaves a follow-up that is not the verification call alone", async () => {
    await configure();
    const lead = await makeLead({
      ownerId: null,
      leadManagerId: pritesh.id,
      leadNextAction: "Collect the spec sheet",
      leadNextActionOwnerId: pritesh.id,
    });
    await raisedBy(lead.id, tele, "desk");
    asPritesh();
    assert.equal((await reassignLead({ leadId: lead.id, salesmanId: rakesh.id })).ok, true);
    assert.equal((await row(lead.id)).leadNextActionOwnerId, pritesh.id);
  });
});

/* ============================= the desk verifier is never silently substituted */

describe("the desk verifier: one configured person, no stand-in", () => {
  test("two different emails: Telecaller and Sales Manager leads still go to the Telecaller verifier", async () => {
    await setting("leads.fieldVerifierByOrgChart", true);
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    await setting("leads.selfRaisedVerifierEmail", mira.email!); // somebody else
    const t = await makeLead();
    await raisedBy(t.id, tele, "desk");
    const own = await makeLead({ ownerId: null, salesManagerId: seema.id, salesManagerDecidedAt: new Date() });
    await raisedBy(own.id, seema, "desk");
    for (const l of [t, own]) {
      assert.equal(verifierOf(await route(l.id)), pritesh.id);
      assert.equal(await canVerifyLeadById(mira, l.id, { designated: true }), false, "the self-raised setting does not override");
      assert.equal(await canVerifyLeadById(pritesh, l.id, { designated: true }), true);
    }
  });

  test("the Telecaller verifier inactive: held with the reason, the self-raised person is NOT put in their place", async () => {
    await setting("leads.fieldVerifierByOrgChart", true);
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    await setting("leads.selfRaisedVerifierEmail", mira.email!);
    await db.update(users).set({ active: false }).where(eq(users.id, pritesh.id));
    const lead = await makeLead();
    await raisedBy(lead.id, tele, "desk");
    const r = await route(lead.id);
    assert.equal(r.kind, "refuse");
    assert.match(r.kind === "refuse" ? r.message : "", /is inactive/);
    assert.equal(await canVerifyLeadById(mira, lead.id, { designated: true }), false);
  });

  test("the Telecaller verifier names an email with no account: held with that reason", async () => {
    await setting("leads.fieldVerifierByOrgChart", true);
    await setting("leads.telecallerVerifierEmail", "nobody-here@test.local");
    await setting("leads.selfRaisedVerifierEmail", mira.email!);
    const lead = await makeLead();
    await raisedBy(lead.id, tele, "desk");
    const r = await route(lead.id);
    assert.equal(r.kind, "refuse");
    assert.match(r.kind === "refuse" ? r.message : "", /has no MahekOne account/);
  });

  test("a held Prospect is visible in the verification queue with that reason", async () => {
    await setting("leads.fieldVerifierByOrgChart", true);
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    await setting("leads.selfRaisedVerifierEmail", mira.email!);
    const boss = await makeUser("Boss Admin", "admin", [["crm", "admin"], ["sales", "admin"]]);
    const lead = await makeLead({
      ownerId: tele.id,
      leadStage: "prospect",
      leadManagerId: pritesh.id,
      leadNextAction: "Sales manager verification",
      leadNextActionOwnerId: pritesh.id,
      leadNextActionOutcome: "Verify what the calling desk collected, then confirm the Prospect",
    });
    await raisedBy(lead.id, tele, "desk");
    await db.update(users).set({ active: false }).where(eq(users.id, pritesh.id));
    await recomputeSalesManagers();
    setTestWorkspace(null);
    setTestUser(boss);
    const queue = await verificationQueue("2026-10-15", { limit: 100 });
    const held = queue.rows.find((r) => r.customerId === lead.id);
    assert.ok(held, "on the list");
    assert.equal(held?.leadManagerId, null);
    assert.match(held?.heldReason ?? "", /is inactive/);
  });

  test("only the self-raised setting named: a Sales Manager's own lead goes to that person, as it always did", async () => {
    await setting("leads.fieldVerifierByOrgChart", true);
    await setting("leads.selfRaisedVerifierEmail", pritesh.email!);
    const own = await makeLead({ ownerId: null, salesManagerId: seema.id, salesManagerDecidedAt: new Date() });
    await raisedBy(own.id, seema, "desk");
    assert.equal(verifierOf(await route(own.id)), pritesh.id);
  });
});
