/**
 * WHO VERIFIES A PROSPECT IS KNOWN WHILE IT IS STILL A SUSPECT.
 *
 * The direct promotion stays exactly as it is: the Telecaller converts, the lead
 * is a Prospect at once, and the Sales Manager's verification is the next thing
 * owed. What this pins is everything around it —
 *
 *   1   Suspect → Prospect immediately, the verification owed to the manager;
 *   2   a lead with an EMPTY territory_region and a Sales Manager who holds the
 *       module but not `lead.verify` (the production shape): suggested, saved
 *       on both seats, and able to verify;
 *   3   the Telecaller can never verify, and cannot be offered themselves;
 *   4   an existing valid manager is preserved;
 *   5   a manual pick works, and is checked against the same list — a posted id
 *       is not a permission;
 *   6   several Sales Managers and no way to choose between them asks, rather
 *       than guessing;
 *   7   with nobody at all the error says so, and does not blame the region;
 *   8   verification opens Qualification, and the desk record carries the
 *       suggestion the picker is drawn from;
 *   9   a manager allocated only a city or a state is still national.
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
  mbosUserTerritories,
  notifications,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { convertLeadToProspect, logQualificationCall, requestProspect } from "@/lib/actions/lead-calling-desk";
import { verifyProspect } from "@/lib/actions/sales-manager-pipeline";
import { leadManagerCandidates } from "@/lib/services/lead-service";
import { deskLeadRecord } from "@/lib/services/lead-calling-desk-service";
import { QUAL_NEXT } from "@/lib/services/lead-qualification-flow-service";
import { CRM_SALES_MANAGER_WORKSPACE } from "@/proxy";
import { setTestWorkspace } from "@/lib/services/crm-sales-manager-scope";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const DAY = "2026-10-05";
type Level = "associate" | "manager";

let tele: typeof users.$inferSelect;
let mgr: typeof users.$inferSelect; // manager level, holds lead.verify
let sm: typeof users.$inferSelect; // CRM ASSOCIATE + the Sales Manager module — the production shape
let sm2: typeof users.$inferSelect; // a second Sales Manager of the same shape
let acctMgr: typeof users.$inferSelect; // a manager by level who cannot verify a lead
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

/** A Suspect with no region and no manager anywhere: what a fresh lead from the desk looks like. */
async function makeLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [r] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      contactPerson: "Ganesh",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Thane, Thane, Maharashtra",
      kind: "lead",
      leadStage: "suspect",
      leadSalesType: "direct",
      leadSource: "manual",
      ownerId: tele.id,
      ...over,
    })
    .returning();
  return r;
}

/** …and ready for Prospect: the five answers in, through the desk's own action. */
async function ready(over: Partial<typeof customers.$inferInsert> = {}) {
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
}

const convert = (customerId: string, managerId?: string) =>
  convertLeadToProspect({
    customerId,
    reasonCode: "regular_requirement",
    customerType: "manufacturer",
    ...(managerId ? { managerId } : {}),
  });

const answers = { visited: "Yes", explained: "Yes", genuine_interest: "Yes", ready_for_trial: "Yes" };
/** Verification happens in the CRM Sales Manager workspace, so that is where the request is made from. */
async function verify(customerId: string) {
  setTestWorkspace(CRM_SALES_MANAGER_WORKSPACE);
  try {
    return await verifyProspect({ customerId, outcome: "verified", answers, corrections: [] });
  } finally {
    setTestWorkspace(null);
  }
}

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
      notifications, timeline_events, audit_log, calls, app_module_access, app_access, mbos_user_territories,
      employee_reporting, employees, customers, products, users, app_settings restart identity cascade`);
  invalidateConfig();
  await seedConfig();
  setTestWorkspace(null);

  tele = await makeUser("Tara Telecaller", "associate", [["crm", "associate"]], ["crm.lead-calling-desk"]);
  mgr = await makeUser("Manoj Manager", "manager", [["crm", "manager"]]);
  sm = await makeUser("Poonam Pashte", "associate", [["crm", "associate"]], ["crm.sales-manager"]);
  sm2 = await makeUser("Second Seat", "associate", [["crm", "associate"]], ["crm.sales-manager"]);
  acctMgr = await makeUser("Anil Accounts", "manager", [["accounts", "manager"]]);
  await db.update(users).set({ reportsToId: mgr.id }).where(eq(users.id, tele.id));
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
  setTestUser(tele);
});

/** Takes the Sales Manager module off somebody without leaving them holding every module (no rows would mean all of them). */
async function narrowAwayFromSeat(where: ReturnType<typeof eq>) {
  await db.update(appModuleAccess).set({ module: "crm.leads" }).where(where);
}

/** The production picture: the only person who can verify is a Sales Manager who holds the seat, not the capability. */
async function onlySeatHolders() {
  await db.update(users).set({ active: false }).where(eq(users.id, mgr.id));
}

describe("1: the promotion is immediate and the verification is owed to the manager", () => {
  test("Suspect → Prospect at once; the manager holds the seat, owes the verification, and is told", async () => {
    const lead = await ready();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.match(r.ok ? (r.message ?? "") : "", /Waiting for Sales Manager verification/);

    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect", "direct promotion is still ON");
    assert.equal(after.prospectRequestState, null, "it never went through the request queue");
    assert.equal(after.leadVerifiedAt, null, "…and it is not verified");
    assert.equal(after.leadManagerId, mgr.id);
    assert.equal(after.leadNextAction, QUAL_NEXT.verify);
    assert.equal(after.leadNextActionOwnerId, mgr.id);
    assert.equal(after.ownerId, tele.id, "the Telecaller still owns the lead");

    const bell = await db.select().from(notifications).where(eq(notifications.userId, mgr.id));
    assert.ok(bell.some((n) => /ready to verify/.test(n.title)), "the manager is told");
  });
});

describe("2: the production shape — empty territory_region, a Sales Manager who holds the seat but not lead.verify", () => {
  test("she is suggested, saved on both seats, and CAN verify, which opens Qualification", async () => {
    await onlySeatHolders();
    await narrowAwayFromSeat(eq(appModuleAccess.userId, sm2.id));
    const lead = await ready({ territoryRegion: null });

    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect");
    assert.equal(after.leadManagerId, sm.id);
    assert.equal(after.salesManagerId, sm.id, "the seat is what lets her verify");
    assert.ok(after.salesManagerDecidedAt, "stamped, so the nightly org-chart pass cannot blank it");
    assert.equal(after.leadNextActionOwnerId, sm.id);

    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "lead.verifier.set"));
    assert.equal(audit.length, 1);

    setTestUser(sm);
    const v = await verify(lead.id);
    assert.equal(v.ok, true, v.ok ? "" : v.error);
    assert.equal((await row(lead.id)).leadStage, "qualification");
    const told = await db.select().from(notifications).where(eq(notifications.userId, tele.id));
    assert.ok(told.some((n) => /qualification is ready/.test(n.title)), "the Telecaller is handed Qualification");
  });
});

describe("3: the Telecaller never verifies", () => {
  test("converting does not let them verify, and they are never offered as the verifier", async () => {
    const lead = await ready();
    assert.equal((await convert(lead.id)).ok, true);
    setTestUser(tele);
    assert.equal((await verify(lead.id)).ok, false);
    assert.equal((await row(lead.id)).leadStage, "prospect");

    const second = await ready();
    const self = await convert(second.id, tele.id);
    assert.equal(self.ok, false);
    assert.equal((await row(second.id)).leadStage, "suspect", "refused before anything was written");
  });
});

describe("4: an existing valid manager is preserved", () => {
  test("a lead already under a manager who can verify keeps them, even with a Sales Manager seat holder about", async () => {
    const lead = await ready({ leadManagerId: mgr.id });
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadManagerId, mgr.id);
    assert.equal(after.leadNextActionOwnerId, mgr.id);
    assert.equal(after.salesManagerId, null, "nobody needed a seat");
    assert.equal(after.leadManagerDecidedAt, null, "an automatic pick is not a decision");
  });

  test("a lead whose Sales Manager seat is filled is verified by that person", async () => {
    const lead = await ready({ salesManagerId: sm2.id });
    assert.equal((await convert(lead.id)).ok, true);
    const after = await row(lead.id);
    assert.equal(after.leadNextActionOwnerId, sm2.id);
    assert.equal(after.salesManagerId, sm2.id);
  });

  test("a seat holder who was 'decided' but can no longer verify is not kept", async () => {
    const lead = await ready({ leadManagerId: acctMgr.id, leadManagerDecidedAt: new Date() });
    assert.equal((await convert(lead.id)).ok, true);
    const after = await row(lead.id);
    assert.equal(after.leadNextActionOwnerId, mgr.id, "the verification goes to somebody who can do it");
  });
});

describe("5: a manual pick", () => {
  test("a seat holder picked by the Telecaller is saved, stamped as a decision, and can verify", async () => {
    const lead = await ready();
    const r = await convert(lead.id, sm.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadManagerId, sm.id);
    assert.equal(after.salesManagerId, sm.id);
    assert.ok(after.leadManagerDecidedAt, "somebody chose this one");
    assert.equal(after.leadNextActionOwnerId, sm.id);
    setTestUser(sm);
    assert.equal((await verify(lead.id)).ok, true);
  });

  test("a posted id is not a permission: somebody who cannot verify is refused, and nothing is written", async () => {
    for (const bad of [acctMgr.id, "usr_does_not_exist"]) {
      const lead = await ready();
      const r = await convert(lead.id, bad);
      assert.equal(r.ok, false);
      assert.match(r.ok ? "" : r.error, /cannot verify leads/);
      assert.equal((await row(lead.id)).leadStage, "suspect");
    }
  });

  test("the request path takes the same pick", async () => {
    const lead = await ready();
    const r = await requestProspect({
      customerId: lead.id,
      reasonCode: "regular_requirement",
      customerType: "manufacturer",
      managerId: sm.id,
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.prospectRequestState, "awaiting");
    assert.equal(after.salesManagerId, sm.id);
  });
});

describe("6: several Sales Managers, nothing to choose between them", () => {
  test("it asks instead of guessing, and a pick resolves it", async () => {
    await onlySeatHolders();
    const lead = await ready();
    const asked = await convert(lead.id);
    assert.equal(asked.ok, false);
    assert.match(asked.ok ? "" : asked.error, /More than one Sales Manager could verify/);
    assert.equal((await row(lead.id)).leadStage, "suspect");

    const picked = await convert(lead.id, sm2.id);
    assert.equal(picked.ok, true, picked.ok ? "" : picked.error);
    assert.equal((await row(lead.id)).salesManagerId, sm2.id);
  });
});

describe("7: with nobody who can verify, the error says so", () => {
  test("it names the real cause, not the region, and the lead stays a Suspect", async () => {
    await onlySeatHolders();
    await narrowAwayFromSeat(eq(appModuleAccess.module, "crm.sales-manager"));
    const lead = await ready({ territoryRegion: null });
    const r = await convert(lead.id);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /Nobody can verify this lead yet/);
    assert.doesNotMatch(r.ok ? "" : r.error, /covers this lead's region/);
    assert.equal((await row(lead.id)).leadStage, "suspect");
  });

  test("a manager who covers a different region is offered, and the sentence says to pick", async () => {
    await onlySeatHolders();
    await narrowAwayFromSeat(eq(appModuleAccess.module, "crm.sales-manager"));
    await db.update(users).set({ active: true }).where(eq(users.id, mgr.id));
    await db.insert(mbosUserTerritories).values({ id: id("ut"), userId: mgr.id, kind: "region", region: "Kerala" });
    const lead = await ready({ territoryRegion: "Maharashtra" });
    const r = await convert(lead.id);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /No Sales Manager covers this lead's region\. Pick who should verify it/);

    const picked = await convert(lead.id, mgr.id);
    assert.equal(picked.ok, true, picked.ok ? "" : picked.error);
  });
});

describe("8: what the desk shows before the button is pressed", () => {
  test("the record carries the suggestion and the options the picker is drawn from", async () => {
    await onlySeatHolders();
    await narrowAwayFromSeat(eq(appModuleAccess.userId, sm2.id));
    const lead = await ready();
    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.verifier?.suggested?.id, sm.id);
    assert.deepEqual(rec?.verifier?.options.map((o) => o.id), [sm.id]);
    assert.equal(rec?.verifier?.message, null);
  });

  test("with nobody, it says why and suggests no one", async () => {
    await onlySeatHolders();
    await narrowAwayFromSeat(eq(appModuleAccess.module, "crm.sales-manager"));
    const lead = await ready();
    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.verifier?.suggested, null);
    assert.deepEqual(rec?.verifier?.options, []);
    assert.match(rec?.verifier?.message ?? "", /Nobody can verify this lead yet/);
  });

  test("once it is a Prospect there is nothing left to choose", async () => {
    const lead = await ready();
    assert.equal((await convert(lead.id)).ok, true);
    assert.equal((await deskLeadRecord(lead.id, DAY))?.verifier, null);
  });
});

describe("9: only region rows make a manager regional", () => {
  test("a manager allocated a city or a state is still national", async () => {
    await db.insert(mbosUserTerritories).values([
      { id: id("ut"), userId: mgr.id, kind: "city", region: "Pune", parent: "Maharashtra" },
      { id: id("ut"), userId: mgr.id, kind: "state", region: "Goa", parent: "" },
    ]);
    const names = (await leadManagerCandidates(null)).map((c) => c.name);
    assert.ok(names.includes("Manoj Manager"));
  });

  test("a region row still narrows, and an accounts-only manager is still not a candidate", async () => {
    await db.insert(mbosUserTerritories).values({ id: id("ut"), userId: mgr.id, kind: "region", region: "Kerala" });
    assert.deepEqual((await leadManagerCandidates(null)).map((c) => c.id), []);
    assert.deepEqual((await leadManagerCandidates("Kerala")).map((c) => c.id), [mgr.id]);
    assert.equal((await leadManagerCandidates("Kerala")).some((c) => c.id === acctMgr.id), false);
  });
});
