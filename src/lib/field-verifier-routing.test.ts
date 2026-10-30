/**
 * THE FIELD VERIFIER: a lead a Salesman raised, or a Salesman now holds.
 *
 *   1  Telecaller-created               → the desk verifier (Pritesh)
 *   2  Sales Manager-created, incl. her own → the desk verifier
 *   3  Salesman-created                 → the field verifier (Seema)
 *   4  currently assigned to a Salesman → the field verifier, whoever raised it
 *   5  unknown creator                  → the desk verifier, as a FALLBACK
 *   6  a verifier is not a follow-up owner: nothing here ever writes owner_id
 *
 * Built on main's own mechanism and its own fixtures: email-keyed settings, the
 * seat-based permission (`crm.sales-manager`), no app level raised for Seema.
 * `leads.fieldVerifierEmail` blank means every test of the existing routing
 * (`telecaller-verifier-routing.test.ts`) is exactly what it was.
 *
 * Real actions against `mahekone_test`.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  auditLog,
  customers,
  mbosDevices,
  mbosTasks,
  mbosUserTerritories,
  notifications,
  products,
  timelineEvents,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig, updateSetting } from "@/lib/config/store";
import { captureLead } from "@/lib/actions/lead-intake";
import { convertLeadToProspect } from "@/lib/actions/lead-calling-desk";
import { verifyProspect } from "@/lib/actions/sales-manager-pipeline";
import { assignDeskLead, bulkAssignDeskLeads } from "@/lib/actions/lead-desk-assignment";
import { bulkReassignLeads, reassignLead } from "@/lib/actions/sales";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { CRM_SALES_MANAGER_WORKSPACE } from "@/proxy";
import { setTestWorkspace } from "@/lib/services/crm-sales-manager-scope";
import { recomputeSalesManagers } from "@/lib/recompute";
import { qualifyLead } from "@/lib/services/lead-qualification-service";
import { canVerifyLeadById, fieldRouteFor } from "@/lib/services/lead-verifier";
import type { MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type Level = "associate" | "manager" | "admin";
type U = typeof users.$inferSelect;

let tele: U; // a Telecaller: CRM associate + the Calling desk
let seema: U; // the field verifier: CRM + Sales associate + the Sales Manager module — nothing raised
let pritesh: U; // the desk verifier: an administrator
let mgr: U; // an ordinary CRM manager
let salesman: U; // owns leads in the field
let bystander: U;
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

type Key = "leads.telecallerVerifierEmail" | "leads.selfRaisedVerifierEmail" | "leads.fieldVerifierEmail";
const setting = async (key: Key, email: string) => {
  const r = await updateSetting(key, email, pritesh.id);
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r));
  invalidateConfig();
};
/** The production configuration: Pritesh for the desk, Seema for the field. */
const configure = async () => {
  await setting("leads.telecallerVerifierEmail", pritesh.email!);
  await setting("leads.selfRaisedVerifierEmail", pritesh.email!);
  await setting("leads.fieldVerifierEmail", seema.email!);
};

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const owner = async (leadId: string) => (await row(leadId)).ownerId ?? null;

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

/** What a real capture writes: who raised it, on which app, and the level held. */
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

const convert = (customerId: string) =>
  convertLeadToProspect({ customerId, reasonCode: "regular_requirement", customerType: "manufacturer", gstin: "27ABCDE1234F1Z5", nextAction: "Call back with the price list", nextActionDate: "2026-12-01" });
const verify = (customerId: string) =>
  verifyProspect({ customerId, outcome: "verified", answers: { current_product: "Asian Paints PU" }, corrections: [] });

const asTele = () => { setTestWorkspace(null); setTestUser(tele); };
const asPritesh = () => { setTestWorkspace(null); setTestUser(pritesh); };
const asSeema = () => { setTestWorkspace(CRM_SALES_MANAGER_WORKSPACE); setTestUser(seema); };
const asMgr = () => { setTestWorkspace(null); setTestUser(mgr); };

const NO_REGION = /No Sales Manager covers this lead's region\. Ask an administrator\./;

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});
after(async () => {
  setTestUser(null);
  setTestWorkspace(null);
  await db.execute(sql.raw(`drop trigger if exists test_block_lead_manager on customers`));
  await db.$client.end();
});
beforeEach(async () => {
  await db.execute(sql.raw(`drop trigger if exists test_block_lead_manager on customers`));
  await db.execute(sql`
    truncate table lead_stage_transitions, lead_verification_corrections, mbos_lead_validations, mbos_tasks,
      mbos_devices, notifications, timeline_events, audit_log, app_module_access, app_access,
      mbos_user_territories, calls, employee_reporting, employees, customers, products, users, app_settings
      restart identity cascade`);
  invalidateConfig();
  await seedConfig();

  tele = await makeUser("Tara Telecaller", "associate", [["crm", "associate"]], ["crm.lead-calling-desk"]);
  seema = await makeUser("Seema Roy", "associate", [["crm", "associate"], ["sales", "associate"]], ["crm.sales-manager"]);
  pritesh = await makeUser("Pritesh Bipin Doshi", "admin", [["crm", "admin"], ["sales", "admin"], ["field", "admin"]]);
  mgr = await makeUser("Manoj Manager", "manager", [["crm", "manager"]]);
  salesman = await makeUser("Rakesh Field", "associate", [["field", "associate"]]);
  bystander = await makeUser("Bina Bystander", "associate", [["crm", "associate"]]);
  await db.insert(mbosDevices).values({ id: id("dev"), userId: salesman.id, deviceId: "dev-sm", active: true });
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
});

/* ===================================================== rules 1–3, by creator */

describe("who raised the lead", () => {
  test("1. a Telecaller's lead goes to Pritesh, and Seema is not involved", async () => {
    await configure();
    const lead = await makeLead();
    await raisedBy(lead.id, tele, "desk");

    asTele();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadManagerId, pritesh.id);
    assert.equal(after.leadNextActionOwnerId, pritesh.id);
    assert.equal(after.ownerId, tele.id, "rule 6: the Telecaller still follows it up");
    assert.notEqual(after.salesManagerId, seema.id);

    const route = await fieldRouteFor({ id: lead.id, ownerId: tele.id });
    assert.equal(route.kind, "desk");
  });

  test("2. a lead the Sales Manager raised herself goes to Pritesh — the self-raised rule, unchanged", async () => {
    await configure();
    asSeema();
    const made = await captureLead({
      salesType: "direct",
      name: "Seema's own shop",
      phone: "9876501234",
      city: "Nashik",
      source: "telecalling",
    } as never);
    assert.ok(made.ok, made.ok ? "" : made.error);
    const lead = await row(made.data.customerId);
    assert.equal(lead.salesManagerId, seema.id);
    assert.equal(lead.leadManagerId, pritesh.id, "seated on the designated approver at capture");

    const route = await fieldRouteFor({ id: lead.id, ownerId: lead.ownerId });
    assert.equal(route.kind, "desk", "a desk lead with a known creator is not the field verifier's");
  });

  test("3. a lead a Salesman raised goes to Seema — by the seat she already uses", async () => {
    await configure();
    const lead = await makeLead({ ownerId: tele.id, salesManagerId: null });
    await raisedBy(lead.id, salesman, "handset", "associate");

    // Not assigned to him any more (a Telecaller has it): rule 3 is about who raised it.
    const route = await fieldRouteFor({ id: lead.id, ownerId: tele.id }, tele.id);
    assert.equal(route.kind, "verifier");
    assert.equal(route.kind === "verifier" && route.id, seema.id);
    assert.equal(route.kind === "verifier" && route.reason, "salesman_created");

    asTele();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadManagerId, seema.id);
    assert.equal(after.leadNextActionOwnerId, seema.id);
    assert.equal(after.ownerId, tele.id, "rule 6: ownership untouched");
  });
});

/* ======================================== rule 4, and its precedence over creator */

describe("a lead currently assigned to a Salesman is Seema's, whoever raised it", () => {
  test("a Telecaller's lead given to a Salesman: Seema verifies it, by her existing seat permission", async () => {
    await configure();
    const lead = await makeLead({ ownerId: tele.id });
    await raisedBy(lead.id, tele, "desk");
    asTele();
    assert.equal((await convert(lead.id)).ok, true);
    assert.equal((await row(lead.id)).leadManagerId, pritesh.id, "Pritesh's while the Telecaller holds it");

    // Given to the Salesman.
    asPritesh();
    const moved = await assignDeskLead({ customerId: lead.id, ownerId: salesman.id });
    assert.equal(moved.ok, true, moved.ok ? "" : moved.error);

    const after = await row(lead.id);
    assert.equal(after.ownerId, salesman.id, "the Salesman owns it");
    assert.equal(after.salesManagerId, seema.id, "she is its Sales Manager — the seat her permission reads");
    assert.equal(after.leadManagerId, seema.id, "and the coordinating seat follows");
    assert.equal(after.leadNextActionOwnerId, seema.id, "the verification call is hers");

    // She can verify it with nothing raised: associate + module + seat.
    assert.equal(await canVerifyLeadById({ id: seema.id, role: "associate" }, lead.id), true);
    asSeema();
    const v = await verify(lead.id);
    assert.equal(v.ok, true, v.ok ? "" : v.error);
    assert.equal((await row(lead.id)).leadVerifiedById, seema.id);
    assert.equal((await row(lead.id)).ownerId, salesman.id, "rule 6: verifying moved no ownership");
  });

  test("a Sales Manager's lead reassigned to a Salesman moves from Pritesh to Seema, with its seat and open call", async () => {
    await configure();
    const lead = await makeLead({ ownerId: null, salesManagerId: mgr.id, salesManagerDecidedAt: new Date() });
    await raisedBy(lead.id, mgr, "desk", "manager");
    // A verification already requested: seated and addressed to the desk verifier, with its call open.
    await db
      .update(customers)
      .set({
        leadManagerId: pritesh.id,
        leadNextActionOwnerId: pritesh.id,
        prospectRequestState: "awaiting",
        prospectRequestedAt: new Date(),
        prospectRequestedById: tele.id,
        prospectRequestReason: "regular_requirement",
      })
      .where(eq(customers.id, lead.id));
    await db.insert(mbosTasks).values({
      id: id("task"), title: "Validation call", assignedToUserId: pritesh.id, assignedByUserId: tele.id,
      priority: "high", dueDate: "2026-12-01", customerId: lead.id, status: "open",
      sourceType: "lead_validation", sourceId: lead.id, createdById: tele.id, updatedById: tele.id,
    });

    asPritesh();
    const r = await reassignLead({ leadId: lead.id, salesmanId: salesman.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const after = await row(lead.id);
    assert.equal(after.ownerId, salesman.id);
    assert.equal(after.leadStage, "suspect", "the stage did not move");
    assert.equal(after.leadManagerId, seema.id);
    assert.equal(after.leadNextActionOwnerId, seema.id);
    assert.equal(after.salesManagerId, mgr.id, "a seat a PERSON decided is left alone");
    const tasks = (await db.select().from(mbosTasks).where(eq(mbosTasks.customerId, lead.id))).filter(
      (t) => t.sourceType === "lead_validation",
    );
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].assignedToUserId, seema.id, "the open call moved with the seat");

    // And back: taken off the Salesman, it is the desk verifier's again.
    const back = await assignDeskLead({ customerId: lead.id, ownerId: tele.id });
    assert.equal(back.ok, true, back.ok ? "" : back.error);
    const again = await row(lead.id);
    assert.equal(again.ownerId, tele.id);
    assert.equal(again.leadManagerId, pritesh.id);
    assert.equal(again.leadNextActionOwnerId, pritesh.id);
  });

  test("bulk reassignment seats each lead, and a lead that fails is named without stopping the rest", async () => {
    await configure();
    const a = await makeLead();
    const b = await makeLead();
    for (const l of [a, b]) {
      await raisedBy(l.id, tele, "desk");
      await db.update(customers).set({ leadManagerId: pritesh.id }).where(eq(customers.id, l.id));
    }
    asPritesh();
    const r = await bulkReassignLeads({ leadIds: [a.id, b.id], salesmanId: salesman.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal(r.ok && r.data.done, 2);
    for (const l of [a, b]) {
      const after = await row(l.id);
      assert.equal(after.ownerId, salesman.id);
      assert.equal(after.leadManagerId, seema.id);
      assert.equal(after.salesManagerId, seema.id);
    }
  });

  test("the nightly org-chart pass seats Seema on Salesman-held leads and leaves decided seats alone", async () => {
    await configure();
    const held = await makeLead({ ownerId: salesman.id, salesManagerId: null });
    const decided = await makeLead({ ownerId: salesman.id, salesManagerId: mgr.id, salesManagerDecidedAt: new Date() });
    const desk = await makeLead({ ownerId: tele.id, salesManagerId: mgr.id });
    await recomputeSalesManagers();
    assert.equal((await row(held.id)).salesManagerId, seema.id);
    assert.equal((await row(decided.id)).salesManagerId, mgr.id, "a person's pick survives");
    assert.equal((await row(desk.id)).salesManagerId, mgr.id, "not a Salesman's lead: untouched");
    assert.equal((await row(held.id)).ownerId, salesman.id);
  });
});

/* ===================================================== Seema's own lead */

describe("Seema's own lead is never hers to verify", () => {
  test("raised by her and then given to a Salesman, it stays with Pritesh and she is refused", async () => {
    await configure();
    asSeema();
    const made = await captureLead({
      salesType: "direct",
      name: "Seema's own shop",
      phone: "9876509999",
      city: "Nashik",
      source: "telecalling",
    } as never);
    assert.ok(made.ok, made.ok ? "" : made.error);
    const leadId = made.data.customerId;
    await db
      .update(customers)
      .set({
        leadStage: "prospect",
        leadDecisionMaker: "Owner",
        /* Verified on its answers, so it has them. */
        customerType: "retailer",
        gstin: "27ABCDE1234F1Z5",
        leadMonthlyVolumeLitres: 300,
        leadCompetitor: "Local thinner",
        leadRequiredProductId: productId,
      })
      .where(eq(customers.id, leadId));

    asPritesh();
    const moved = await assignDeskLead({ customerId: leadId, ownerId: salesman.id });
    assert.equal(moved.ok, true, moved.ok ? "" : moved.error);

    const route = await fieldRouteFor({ id: leadId, ownerId: salesman.id });
    assert.equal(route.kind, "verifier");
    assert.equal(route.kind === "verifier" && route.id, pritesh.id);
    assert.equal(route.kind === "verifier" && route.reason, "own_lead");

    // Seema still holds the seat and the module, and may not verify her own lead.
    assert.equal(await canVerifyLeadById({ id: seema.id, role: "associate" }, leadId), false);
    asSeema();
    const refused = await verify(leadId);
    assert.equal(refused.ok, false);
    assert.equal((await row(leadId)).leadVerifiedAt, null);

    asPritesh();
    const done = await verify(leadId);
    assert.equal(done.ok, true, done.ok ? "" : done.error);
  });
});

/* ===================================================== rule 5, the fallback */

describe("an unknown creator falls back to Pritesh — only when nothing else answered, and only if usable", () => {
  test("a lead with no creator record and no seat goes to Pritesh instead of a regional guess", async () => {
    /* Not configured: the only regional answer is the requester herself, and nobody
       verifies their own request - refused in words (the Org Chart cannot answer: mgr is unlinked). */
    const before = await makeLead({ ownerId: mgr.id });
    asMgr();
    const old = await convert(before.id);
    assert.equal(old.ok, false);
    assert.match(old.ok ? "" : old.error, /nobody verifies their own request/);

    await configure();
    const lead = await makeLead({ ownerId: mgr.id });
    asMgr();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadManagerId, pritesh.id);
    assert.equal(after.ownerId, mgr.id, "rule 6: the fallback assigned no follow-up");
    assert.equal((await db.select().from(timelineEvents).where(
      and(eq(timelineEvents.customerId, lead.id), eq(timelineEvents.eventType, "lead_created")),
    )).length, 0, "and no creator history was invented");
  });

  test("an unknown creator whom a Salesman holds is Seema's by assignment", async () => {
    await configure();
    const lead = await makeLead({ ownerId: salesman.id, salesManagerId: null });
    const route = await fieldRouteFor({ id: lead.id, ownerId: salesman.id });
    assert.equal(route.kind === "verifier" && route.id, seema.id);
    assert.equal(route.kind === "verifier" && route.reason, "assigned");
  });

  test("a seat an org chart or a person set still answers first; the fallback does not undo it", async () => {
    await configure();
    const lead = await makeLead({ ownerId: tele.id, salesManagerId: mgr.id, salesManagerDecidedAt: new Date() });
    asTele();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadManagerId, mgr.id, "a seat a person decided answers first");
  });

  test("with Pritesh not configured the fallback is simply off", async () => {
    await setting("leads.fieldVerifierEmail", seema.email!);
    const lead = await makeLead({ ownerId: mgr.id });
    asMgr();
    const r = await convert(lead.id);
    assert.equal(r.ok, false, "the regional default is the requester herself, so it is refused");
    assert.match(r.ok ? "" : r.error, /nobody verifies their own request/);
    assert.notEqual((await row(lead.id)).leadManagerId, pritesh.id);
  });

  test("with Pritesh configured but unauthorized the conversion is REFUSED in words, never rerouted", async () => {
    await configure();
    await db.update(users).set({ role: "associate" }).where(eq(users.id, pritesh.id));
    await db.update(appAccess).set({ role: "associate" }).where(eq(appAccess.userId, pritesh.id));
    const lead = await makeLead({ ownerId: mgr.id });
    setTestWorkspace(null);
    setTestUser(mgr);
    const r = await convert(lead.id);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /does not hold the verification permission/);
    assert.equal((await row(lead.id)).leadStage, "suspect");
  });
});

/* ============================================= configuration and refusals */

describe("configuration", () => {
  test("blank leads.fieldVerifierEmail is exactly the routing main has today", async () => {
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    const lead = await makeLead({ ownerId: salesman.id });
    const route = await fieldRouteFor({ id: lead.id, ownerId: salesman.id });
    assert.equal(route.kind, "off");
    asPritesh();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadManagerId, mgr.id, "the regional default, exactly as before");
  });

  test("a field verifier who matches no active account refuses in words and moves nothing", async () => {
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    await setting("leads.fieldVerifierEmail", "nobody@test.local");
    const lead = await makeLead({ ownerId: salesman.id });
    asPritesh();
    const r = await convert(lead.id);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /has no active account/);
    assert.equal((await row(lead.id)).leadStage, "suspect");
  });

  test("a field verifier with neither the permission nor the seat module is refused, not routed around", async () => {
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    // An account with no CRM at all: it can neither verify nor hold the seat. (A
    // whole-CRM associate would pass — that is how main's own seat check reads it.)
    const outsider = await makeUser("Olive Outsider", "associate", [["field", "associate"]]);
    await setting("leads.fieldVerifierEmail", outsider.email!);
    const lead = await makeLead({ ownerId: salesman.id });
    asPritesh();
    const r = await convert(lead.id);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /neither the verification permission nor the Sales Manager seat/);
  });

  test("nobody else may verify a field lead by seat: another Sales Manager seat holder is not the designated one", async () => {
    await configure();
    const lead = await makeLead({ ownerId: salesman.id, salesManagerId: null });
    await db
      .update(customers)
      .set({ leadStage: "prospect", leadManagerId: seema.id, leadNextActionOwnerId: seema.id })
      .where(eq(customers.id, lead.id));
    await recomputeSalesManagers();
    assert.equal((await row(lead.id)).salesManagerId, seema.id);
    assert.equal(await canVerifyLeadById({ id: bystander.id, role: "associate" }, lead.id), false);
  });
});

/* ======================================= the handset path records its creator */

describe("the handset", () => {
  const principalFor = (u: U, role: Level) =>
    ({ user: u, deviceId: "dev-sm", role, scope: { kind: "all" } }) as unknown as MbosPrincipal;
  const handsetLead = (): SyncItem => {
    const entityId = id("mbos");
    return {
      queueId: id("q"),
      entityId,
      entityType: "lead",
      op: "create",
      idempotencyKey: `${entityId}:create`,
      clientCreatedAt: Date.now(),
      payload: {
        name: "Rakesh",
        companyName: "New Paints",
        city: "Nashik",
        mobile: `98${Math.floor(10000000 + Math.random() * 89999999)}`,
      },
    } as unknown as SyncItem;
  };

  test("a Salesman's new lead records the level he held, once, and is born under Seema", async () => {
    await configure();
    await db.insert(mbosUserTerritories).values({ id: id("ut"), userId: salesman.id, kind: "city", region: "Nashik" });
    const item = handsetLead();
    const [res] = await ingestSyncBatch(principalFor(salesman, "associate"), [item]);
    assert.equal(res.status, "accepted", JSON.stringify(res));
    await ingestSyncBatch(principalFor(salesman, "associate"), [{ ...item, queueId: id("q") } as SyncItem]); // a re-send

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, item.entityId), eq(auditLog.action, "lead.captured")));
    assert.equal(audits.length, 1, "written once, however often it is sent");
    assert.equal(audits[0].actorRole, "associate");
    assert.equal(audits[0].actorApp, "field");

    const lead = await row(item.entityId);
    assert.equal(lead.ownerId, salesman.id, "he keeps visiting it");
    assert.equal(lead.salesManagerId, seema.id, "born under the field verifier");

    // And qualifying it in the field seats her, not the org chart's guess.
    const q = await qualifyLead(item.entityId, salesman.id, "Rakesh");
    assert.equal(q.leadManagerId, seema.id);
    assert.equal(q.assigned, true);
    const notified = await db.select().from(notifications).where(eq(notifications.userId, seema.id));
    assert.ok(notified.length > 0, "she is told");
  });
});

/* ======================================== a move is one commit or nothing */

describe("a failed seat update rolls the whole move back", () => {
  const block = async () => {
    await db.execute(sql.raw(`
      create or replace function test_block_lead_manager_fn() returns trigger language plpgsql as $$
      begin
        if new.lead_manager_id is distinct from old.lead_manager_id then
          raise exception 'seat write blocked by test';
        end if;
        return new;
      end $$`));
    await db.execute(
      sql.raw(`create trigger test_block_lead_manager before update on customers for each row execute function test_block_lead_manager_fn()`),
    );
  };
  const unblock = () => db.execute(sql.raw(`drop trigger if exists test_block_lead_manager on customers`));

  test("single reassignment: the owner does not move, and the failure is returned", async () => {
    await configure();
    const lead = await makeLead({ salesManagerId: null });
    await raisedBy(lead.id, tele, "desk");
    await db.update(customers).set({ leadManagerId: pritesh.id }).where(eq(customers.id, lead.id));
    await block();
    try {
      asPritesh();
      const r = await reassignLead({ leadId: lead.id, salesmanId: salesman.id });
      assert.equal(r.ok, false);
      assert.equal(await owner(lead.id), tele.id, "the owner did not move");
      assert.equal((await row(lead.id)).leadManagerId, pritesh.id);
      const audits = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, lead.id), eq(auditLog.action, "mbos.lead.reassign")));
      assert.equal(audits.length, 0, "no audit row for a move that did not happen");
    } finally {
      await unblock();
    }
  });

  test("desk assignment says nothing was changed", async () => {
    await configure();
    const lead = await makeLead();
    await raisedBy(lead.id, tele, "desk");
    await db.update(customers).set({ leadManagerId: pritesh.id }).where(eq(customers.id, lead.id));
    await block();
    try {
      asPritesh();
      const r = await assignDeskLead({ customerId: lead.id, ownerId: salesman.id });
      assert.equal(r.ok, false);
      assert.match(!r.ok ? r.error : "", /nothing was changed/);
      assert.equal(await owner(lead.id), tele.id);
    } finally {
      await unblock();
    }
  });

  test("bulk: one lead's failure is named and does not stop or half-do the others", async () => {
    await configure();
    const failing = await makeLead();
    await raisedBy(failing.id, tele, "desk");
    await db.update(customers).set({ leadManagerId: pritesh.id }).where(eq(customers.id, failing.id));
    const fine = await makeLead({ leadManagerId: null });
    await raisedBy(fine.id, tele, "desk");
    await block();
    try {
      asPritesh();
      const r = await bulkAssignDeskLeads({ leadIds: [failing.id, fine.id], ownerId: salesman.id });
      assert.equal(r.ok, true, r.ok ? "" : r.error);
      assert.equal(r.ok && r.data.done, 1);
      assert.deepEqual(r.ok ? r.data.failed.map((f) => f.id) : [], [failing.id]);
      assert.equal(await owner(failing.id), tele.id, "rolled back whole");
      assert.equal(await owner(fine.id), salesman.id, "the one after it still moved");
    } finally {
      await unblock();
    }
  });
});

/* ===================================== an unusable verifier is said, not swallowed */

describe("a verifier who cannot be used is reported, and nobody else is seated", () => {
  test("the move commits, the seat is left, and the answer says so", async () => {
    await configure();
    const lead = await makeLead();
    await raisedBy(lead.id, tele, "desk");
    await db.update(customers).set({ leadManagerId: pritesh.id }).where(eq(customers.id, lead.id));
    // Seema's account is closed: configured, but nobody active answers to the address.
    await db.update(users).set({ active: false }).where(eq(users.id, seema.id));

    asPritesh();
    const r = await assignDeskLead({ customerId: lead.id, ownerId: salesman.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.match(r.ok ? (r.message ?? "") : "", /verification seat was not moved/);
    assert.ok(r.ok && (r.warnings?.length ?? 0) > 0);
    const after = await row(lead.id);
    assert.equal(after.ownerId, salesman.id);
    assert.equal(after.leadManagerId, pritesh.id, "nobody else was seated");
    assert.notEqual(after.salesManagerId, seema.id);
  });
});
