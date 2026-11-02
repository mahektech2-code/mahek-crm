/**
 * A SALESMAN'S LEAD GOES TO THE FIELD VERIFIER BEFORE THE REQUESTER'S ORG CHART IS ASKED.
 *
 * Production shape: Pritesh is the desk verifier, Seema the field verifier, and a
 * Telecaller (Jyoti) reports to Pritesh on the chart. Converting a lead a Salesman
 * raised or holds must reach Seema, not Pritesh, even for that Telecaller; every
 * desk lead keeps the Org Chart first and its fallbacks. Nobody is unlinked.
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
  products,
  timelineEvents,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig, updateSetting } from "@/lib/config/store";
import { convertLeadToProspect } from "@/lib/actions/lead-calling-desk";
import { verifyProspect } from "@/lib/actions/sales-manager-pipeline";
import { canVerifyLeadById } from "@/lib/services/lead-verifier";
import { CRM_EVENT } from "@/lib/timeline";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type Level = "associate" | "manager" | "admin";
type U = typeof users.$inferSelect;

let jyoti: U; // Telecaller on the chart, reports to Pritesh
let loose: U; // Telecaller nobody linked
let seema: U; // field verifier, reports to Pritesh
let pritesh: U; // desk verifier, administrator
let sam: U; // another Sales Manager, reports to Pritesh
let other: U; // a manager with lead.verify, on nobody's line
let rakesh: U; // a Salesman
let productId: string;
const emp: Record<string, string> = {};

async function makeUser(name: string, level: Level, apps: [string, Level][], modules: string[] = []) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role: level,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  for (const [app, role] of apps) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: app as never, role });
  for (const key of modules) await db.insert(appModuleAccess).values({ id: id("ama"), userId: row.id, app: "crm", module: key });
  return row;
}

let rowNo = 500;
async function makeEmployee(key: string) {
  rowNo += 1;
  const [e] = await db
    .insert(employees)
    .values({
      id: id("emp"),
      employeeCode: `SLR-${rowNo}`,
      name: `Employee ${key}`,
      status: "active",
      sheetStatus: "present",
      rowNumber: rowNo,
      raw: {},
      rowHash: `slr-${rowNo}-${randomUUID()}`,
    })
    .returning();
  emp[key] = e.id;
}
const link = (user: U, key: string) => db.update(users).set({ employeeId: emp[key] }).where(eq(users.id, user.id));
const report = (who: string, to: string) =>
  db.insert(employeeReporting).values({ id: id("er"), employeeId: emp[who], managerId: emp[to] });

const setting = async (key: string, value: string) => {
  const r = await updateSetting(key as never, value as never, pritesh.id);
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r));
  invalidateConfig();
};
/** The approved production configuration. */
const configure = async () => {
  await setting("leads.telecallerVerifierEmail", pritesh.email!);
  await setting("leads.selfRaisedVerifierEmail", pritesh.email!);
  await setting("leads.fieldVerifierEmail", seema.email!);
};

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
async function makeLead(owner: U, over: Partial<typeof customers.$inferInsert> = {}) {
  const [r] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      contactPerson: "Ganesh",
      phone: testPhone(),
      city: "Nashik",
      kind: "lead",
      leadStage: "suspect",
      leadSalesType: "direct",
      leadSource: "manual",
      ownerId: owner.id,
      leadDecisionMaker: "Owner",
      leadMonthlyVolumeLitres: 300,
      leadRequiredProductId: productId,
      leadCompetitor: "Local thinner",
      ...over,
    })
    .returning();
  return r;
}
/** What a real capture writes: who raised it, on which app, and the level held. */
async function raisedBy(leadId: string, by: U, how: "desk" | "handset") {
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
      actorRole: "associate",
      actorApp: "field",
      beforeState: null,
      afterState: { channel: "handset" },
    });
  }
}
const convert = (customerId: string) =>
  convertLeadToProspect({
    customerId,
    reasonCode: "regular_requirement",
    customerType: "manufacturer",
    gstin: "27ABCDE1234F1Z5",
    nextAction: "Call back with the price list",
    nextActionDate: "2026-12-01",
  });
const fallbacks = async (leadId: string) =>
  (await db.select().from(timelineEvents).where(eq(timelineEvents.customerId, leadId))).filter(
    (e) => e.eventType === CRM_EVENT.verifierFallback,
  );

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});
after(async () => {
  setTestUser(null);
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

  jyoti = await makeUser("Jyoti Telecaller", "associate", [["crm", "associate"]], ["crm.lead-calling-desk"]);
  loose = await makeUser("Lena Loose", "associate", [["crm", "associate"]], ["crm.lead-calling-desk"]);
  seema = await makeUser("Seema Roy", "associate", [["crm", "associate"], ["sales", "manager"]], ["crm.sales-manager", "crm.leads"]);
  pritesh = await makeUser("Pritesh Bipin Doshi", "admin", [["crm", "admin"], ["sales", "admin"], ["field", "admin"]]);
  sam = await makeUser("Sam Sales Manager", "associate", [["crm", "associate"]], ["crm.sales-manager", "crm.lead-calling-desk"]);
  other = await makeUser("Olga Other", "manager", [["crm", "manager"]]);
  rakesh = await makeUser("Rakesh Field", "associate", [["field", "associate"]]);
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });

  /* Jyoti, Seema and Sam all report to Pritesh. Lena is not linked. Nobody is unlinked by this change. */
  for (const k of ["jyoti", "seema", "sam", "pritesh"]) await makeEmployee(k);
  await link(jyoti, "jyoti");
  await link(seema, "seema");
  await link(sam, "sam");
  await link(pritesh, "pritesh");
  await report("jyoti", "pritesh");
  await report("seema", "pritesh");
  await report("sam", "pritesh");
  await configure();
});

describe("a Salesman's lead goes to Seema, whoever converts it", () => {
  test("Jyoti converts a lead a Salesman raised (now owned at the desk): Seema", async () => {
    const lead = await makeLead(jyoti);
    await raisedBy(lead.id, rakesh, "handset");
    setTestUser(jyoti);
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadManagerId, seema.id);
  });

  test("Seema and the administrator may verify it, and a manager on nobody's line may not", async () => {
    const lead = await makeLead(jyoti);
    await raisedBy(lead.id, rakesh, "handset");
    setTestUser(jyoti);
    assert.equal((await convert(lead.id)).ok, true);
    assert.equal(await canVerifyLeadById({ id: seema.id, role: seema.role }, lead.id), true);
    assert.equal(await canVerifyLeadById({ id: pritesh.id, role: pritesh.role }, lead.id), true);
    setTestUser(other);
    const refused = await verifyProspect({
      customerId: lead.id,
      outcome: "verified",
      answers: { current_product: "Asian Paints PU" },
      corrections: [],
    } as never);
    assert.equal(refused.ok, false);
    assert.equal((await row(lead.id)).leadVerifiedAt, null);
  });
});

describe("every other lead keeps the Org Chart first, and Pritesh", () => {
  test("Jyoti converts a lead a Telecaller owns and raised: Pritesh (her chart manager)", async () => {
    const lead = await makeLead(jyoti);
    await raisedBy(lead.id, jyoti, "desk");
    setTestUser(jyoti);
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadManagerId, pritesh.id);
  });

  test("an unlinked Telecaller converts a Telecaller-owned lead: Pritesh (the named desk verifier)", async () => {
    const lead = await makeLead(loose);
    await raisedBy(lead.id, loose, "desk");
    setTestUser(loose);
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadManagerId, pritesh.id);
    assert.equal((await fallbacks(lead.id)).length, 1, "the settings fallback is still said out loud");
  });

  test("a Sales Manager converts a lead she raised and owns: her chart manager, Pritesh", async () => {
    const lead = await makeLead(sam);
    await raisedBy(lead.id, sam, "desk");
    setTestUser(sam);
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadManagerId, pritesh.id);
  });

  test("with the field setting blank nothing changes: the chart still answers first", async () => {
    await db.execute(sql`update app_settings set value = '""'::jsonb where key = 'leads.fieldVerifierEmail'`);
    invalidateConfig();
    const lead = await makeLead(jyoti);
    await raisedBy(lead.id, rakesh, "handset");
    setTestUser(jyoti);
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadManagerId, pritesh.id, "off means exactly as before");
  });

});
