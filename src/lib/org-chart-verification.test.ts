/**
 * ORG CHART FIRST: THE PERSON LOWER DOWN ASKS, THE NEAREST ELIGIBLE PERSON ABOVE VERIFIES.
 *
 *   routing   whoever MAKES the request is the starting point; the Org Chart is always
 *             asked first; the named-person settings are a FALLBACK only
 *   fallback  visible (timeline entry + a note on the lead); never the requester
 *   gate      the requester never verifies; where the chart names somebody only they
 *             (or the person it was addressed to, or an administrator) may
 *   review    whoever collected the answers is the starting point for the review
 *   switch    `leads.fieldVerifierByOrgChart` is retired
 *
 * Accounts are synthetic and named for their jobs; nothing here reads a name -
 * identity is `users.employee_id`, the chart is `employee_reporting`.
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
  customers,
  employeeReporting,
  employees,
  products,
  timelineEvents,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { getConfig, invalidateConfig, seedConfig, updateSetting } from "@/lib/config/store";
import { convertLeadToProspect } from "@/lib/actions/lead-calling-desk";
import { canVerifyLeadById, requireQualificationApprover } from "@/lib/services/lead-verifier";
import { orgChartVerifierFor } from "@/lib/services/org-verifier-resolver";
import { CRM_EVENT } from "@/lib/timeline";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type Level = "associate" | "manager" | "admin";
type U = typeof users.$inferSelect;

let tele: U; // Telecaller (the requester): CRM associate + the Calling desk
let mira: U; // Sales Manager above Tara
let seema: U; // Sales Manager above Mira
let pritesh: U; // administrator at the top; the named desk verifier in Settings
let nina: U; // a manager NOT on Tara's line (holds lead.verify)
let loose: U; // a Telecaller nobody linked in HRMS
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

let rowNo = 200;
async function makeEmployee(key: string) {
  rowNo += 1;
  const [e] = await db
    .insert(employees)
    .values({
      id: id("emp"),
      employeeCode: `OCV-${rowNo}`,
      name: `Employee ${key}`,
      status: "active",
      sheetStatus: "present",
      rowNumber: rowNo,
      raw: {},
      rowHash: `ocv-${rowNo}-${randomUUID()}`,
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

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
async function makeLead(owner: U | null, over: Partial<typeof customers.$inferInsert> = {}) {
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
      ownerId: owner?.id ?? null,
      leadDecisionMaker: "Owner",
      leadMonthlyVolumeLitres: 300,
      leadRequiredProductId: productId,
      leadCompetitor: "Local thinner",
      ...over,
    })
    .returning();
  return r;
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
const as = (u: U) => setTestUser(u);

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

  tele = await makeUser("Tara Telecaller", "associate", [["crm", "associate"]], ["crm.lead-calling-desk"]);
  loose = await makeUser("Lena Loose", "associate", [["crm", "associate"]], ["crm.lead-calling-desk"]);
  pritesh = await makeUser("Pritesh Bipin Doshi", "admin", [["crm", "admin"], ["sales", "admin"]]);
  mira = await makeUser("Mira Manager", "associate", [["crm", "associate"]], ["crm.sales-manager"]);
  seema = await makeUser("Seema Roy", "associate", [["crm", "associate"]], ["crm.sales-manager"]);
  nina = await makeUser("Nina Other", "manager", [["crm", "manager"]]);
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });

  /* Tara → Mira → Seema → Pritesh. Lena is not linked at all. */
  for (const k of ["tele", "mira", "seema", "pritesh"]) await makeEmployee(k);
  await link(tele, "tele");
  await link(mira, "mira");
  await link(seema, "seema");
  await link(pritesh, "pritesh");
  await report("tele", "mira");
  await report("mira", "seema");
  await report("seema", "pritesh");
});

describe("routing: the requester's own chart decides", () => {
  test("a Telecaller's request goes to the manager above her — Mira — not to a named account", async () => {
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    const lead = await makeLead(tele);
    as(tele);
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadManagerId, mira.id);
    assert.equal(after.leadNextActionOwnerId, mira.id);
    assert.equal(after.ownerId, tele.id, "she still follows it up: Mira verifies, she does not own");
    assert.doesNotMatch(after.leadNextActionOutcome ?? "", /Routed through Settings/);
    const fallbacks = await db.select().from(timelineEvents).where(eq(timelineEvents.eventType, CRM_EVENT.verifierFallback));
    assert.equal(fallbacks.length, 0, "the chart answered, so nothing fell back");
  });

  test("a Sales Manager's own request goes to HER manager on the chart", async () => {
    const lead = await makeLead(null, { salesManagerId: mira.id });
    as(mira);
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadManagerId, seema.id);
  });

  test("a manager who has left is passed over to the next one up", async () => {
    await db.update(employees).set({ status: "inactive" }).where(eq(employees.id, emp.mira));
    const lead = await makeLead(tele);
    as(tele);
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadManagerId, seema.id);
  });

  test("the chart beats the settings: a named account never outranks it", async () => {
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    await setting("leads.selfRaisedVerifierEmail", pritesh.email!);
    const lead = await makeLead(tele);
    as(tele);
    assert.ok((await convert(lead.id)).ok);
    assert.equal((await row(lead.id)).leadManagerId, mira.id);
  });

  test("the resolver never names the requester, and says why it cannot when it cannot", async () => {
    const ok = await orgChartVerifierFor(tele.id);
    assert.ok(ok.ok && ok.id === mira.id && ok.id !== tele.id);
    const top = await orgChartVerifierFor(pritesh.id);
    assert.equal(top.ok, false);
    const unlinked = await orgChartVerifierFor(loose.id);
    assert.equal(!unlinked.ok && unlinked.reason, "subject_unmapped");
  });
});

describe("fallback: only when the chart cannot answer, and it is visible", () => {
  test("an unlinked requester falls back to the named account, and the lead says so", async () => {
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    const lead = await makeLead(loose);
    as(loose);
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadManagerId, pritesh.id, "the settings answered because the chart could not");
    assert.match(after.leadNextActionOutcome ?? "", /Routed through Settings, not the Org Chart: the person who asked is not linked/);
    const [ev] = await db.select().from(timelineEvents).where(eq(timelineEvents.eventType, CRM_EVENT.verifierFallback));
    assert.ok(ev, "a timeline entry records the fallback");
    assert.equal(ev.customerId, lead.id);
    assert.equal(ev.actorUserId, loose.id);
  });

  test("a fallback that would be the requester is REFUSED, with what to fix", async () => {
    /* Mira is not linked on the chart and holds the Sales Manager seat on a lead nobody owns,
       with no designated approver: the only fallback left is her own seat. */
    await db.update(users).set({ employeeId: null }).where(eq(users.id, mira.id));
    const lead = await makeLead(null, { salesManagerId: mira.id });
    as(mira);
    const r = await convert(lead.id);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /nobody verifies their own request/);
    assert.match(!r.ok ? r.error : "", /link you to your manager in HRMS|name another verifier in Settings/);
    assert.equal((await row(lead.id)).leadStage, "suspect", "nothing moved");
  });
});

describe("the act of verifying", () => {
  test("only the chart's verifier may; the requester, another manager and a stranger may not; an administrator may", async () => {
    const lead = await makeLead(tele);
    as(tele);
    assert.ok((await convert(lead.id)).ok);
    assert.equal((await row(lead.id)).leadStage, "prospect");

    assert.equal(await canVerifyLeadById(mira, lead.id, { designated: true }), true, "Mira, above the requester");
    assert.equal(await canVerifyLeadById(tele, lead.id, { designated: true }), false, "the requester never");
    assert.equal(await canVerifyLeadById(nina, lead.id, { designated: true }), false, "a manager off the line, though she holds lead.verify");
    assert.equal(await canVerifyLeadById(pritesh, lead.id, { designated: true }), true, "an administrator keeps the reach they have");
  });

  test("once the lead is verified the rule no longer applies to it", async () => {
    const lead = await makeLead(tele);
    as(tele);
    assert.ok((await convert(lead.id)).ok);
    await db.update(customers).set({ leadVerifiedAt: new Date() }).where(eq(customers.id, lead.id));
    assert.equal(await canVerifyLeadById(nina, lead.id, { designated: true }), true, "judged as it always was");
  });

  test("where the chart could not answer, the old rules apply minus the requester", async () => {
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    const lead = await makeLead(loose);
    as(loose);
    assert.ok((await convert(lead.id)).ok);
    assert.equal(await canVerifyLeadById(loose, lead.id, { designated: true }), false, "the requester never");
    assert.equal(await canVerifyLeadById(pritesh, lead.id, { designated: true }), true, "the fallback account");
  });
});

describe("the Qualification review", () => {
  test("starting from whoever collected it, only the manager above reviews", async () => {
    const lead = await makeLead(tele, { leadStage: "qualification", salesManagerId: mira.id });
    as(nina);
    const refused = await requireQualificationApprover(lead.id);
    assert.equal(refused.ok, false);
    assert.match(!refused.ok ? refused.message : "", /reviewed by Mira Manager/);
    as(mira);
    const ok = await requireQualificationApprover(lead.id);
    assert.equal(ok.ok, true, ok.ok ? "" : ok.message);
  });

  test("where the collector is not on the chart, the review is judged as it always was", async () => {
    const lead = await makeLead(loose, { leadStage: "qualification" });
    as(nina);
    const r = await requireQualificationApprover(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.message);
  });
});

describe("the old switch is retired", () => {
  test("it is gone from the settings, and nothing can be saved under it", async () => {
    const config = (await getConfig()) as Record<string, unknown>;
    assert.equal("leads.fieldVerifierByOrgChart" in config, false);
    const r = await updateSetting("leads.fieldVerifierByOrgChart" as never, true as never, pritesh.id);
    assert.equal(r.ok, false);
  });
});
