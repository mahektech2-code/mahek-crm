/**
 * WHO VERIFIES A PROSPECT, ON THE THREE WORKFLOWS THAT MUST NOT BE MERGED.
 *
 *   A  a lead a TELECALLER works (owned by a Calling-desk worker, or by nobody):
 *      `leads.telecallerVerifierEmail` names the verifier, nobody chooses, and it
 *      does NOT matter whether the org chart has filled `sales_manager_id` or
 *      whether any manager covers the region;
 *   B  a lead a SALES MANAGER raised herself: `leads.selfRaisedVerifierEmail`,
 *      the mechanism that already existed - and untouched by A's setting;
 *   C  a lead a SALESMAN owns, and anything a PERSON decided (a Sales Manager
 *      seat, a lead manager): routing exactly as it was, whatever A is set to.
 *
 * Both settings are blank by default, and blank means "as before". No person is
 * named anywhere in the code under test; the tests name one only to configure it.
 *
 * Real actions against `mahekone_test`.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { invalidateConfig, seedConfig, updateSetting } from "@/lib/config/store";
import { captureLead } from "@/lib/actions/lead-intake";
import { convertLeadToProspect } from "@/lib/actions/lead-calling-desk";
import { verifyProspect } from "@/lib/actions/sales-manager-pipeline";
import { CRM_SALES_MANAGER_WORKSPACE } from "@/proxy";
import { setTestWorkspace } from "@/lib/services/crm-sales-manager-scope";
import { QUAL_NEXT } from "@/lib/services/lead-qualification-flow-service";
import { isTelecallerHandled, telecallerRouteFor } from "@/lib/services/lead-verifier";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type Level = "associate" | "manager" | "admin";

let tele: typeof users.$inferSelect; // a Telecaller: CRM associate + the Calling desk
let seema: typeof users.$inferSelect; // the Sales Manager: CRM associate + the Sales Manager module
let pritesh: typeof users.$inferSelect; // the intended verifier: an administrator
let mgr: typeof users.$inferSelect; // an ordinary CRM manager, the existing routing's answer
let salesman: typeof users.$inferSelect; // owns leads in the field
let bystander: typeof users.$inferSelect; // an associate who cannot verify anything
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

const setting = async (key: "leads.telecallerVerifierEmail" | "leads.selfRaisedVerifierEmail", email: string) => {
  const r = await updateSetting(key, email, pritesh.id);
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r));
  invalidateConfig();
};

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];

/** A Suspect with everything a Prospect needs already answered. */
async function makeSuspect(over: Partial<typeof customers.$inferInsert> = {}) {
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

/* Converted WITHOUT naming anybody: no `managerId` is ever passed in this file. */
const convert = (customerId: string) =>
  convertLeadToProspect({ customerId, reasonCode: "regular_requirement", customerType: "manufacturer" });

const asTele = () => {
  setTestWorkspace(null);
  setTestUser(tele);
};
const asPritesh = () => {
  setTestWorkspace(null);
  setTestUser(pritesh);
};
const asSeema = () => {
  setTestWorkspace(CRM_SALES_MANAGER_WORKSPACE);
  setTestUser(seema);
};

const verify = (customerId: string) =>
  verifyProspect({ customerId, outcome: "verified", answers: {}, corrections: [] });

const NO_REGION = /No Sales Manager covers this lead's region\. Ask an administrator\./;

const cover = (userId: string, region: string) =>
  db.insert(mbosUserTerritories).values({ id: id("ut"), userId, kind: "region", region });

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
      notifications, timeline_events, audit_log, app_module_access, app_access, mbos_user_territories, calls,
      employee_reporting, employees, customers, products, users, app_settings restart identity cascade`);
  invalidateConfig();
  await seedConfig();

  tele = await makeUser("Tara Telecaller", "associate", [["crm", "associate"]], ["crm.lead-calling-desk"]);
  seema = await makeUser("Seema Roy", "associate", [["crm", "associate"]], ["crm.sales-manager"]);
  pritesh = await makeUser("Pritesh Bipin Doshi", "admin", [["crm", "admin"]]);
  mgr = await makeUser("Manoj Manager", "manager", [["crm", "manager"]]);
  salesman = await makeUser("Rakesh Field", "associate", [["field", "associate"]]);
  bystander = await makeUser("Bina Bystander", "associate", [["crm", "associate"]]);
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
});

/* ═══════════════════════════ A — a lead a Telecaller works: the designated verifier */

describe("A: a Telecaller's lead goes to the designated verifier, with nothing to choose", () => {
  test("1. sales_manager_id empty: owed to them, they can verify it, nothing else moves", async () => {
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    const lead = await makeSuspect();

    asTele();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect");
    assert.equal(after.leadNextAction, QUAL_NEXT.verify);
    assert.equal(after.leadNextActionOwnerId, pritesh.id, "the verification is theirs");
    assert.equal(after.leadManagerId, pritesh.id, "the coordinating seat is filled");
    assert.equal(after.leadManagerDecidedAt, null, "filled, not decided - nobody chose it");
    assert.equal(after.salesManagerId, null, "the sales manager seat is not touched");
    assert.equal(after.ownerId, tele.id, "the Telecaller still owns it");
    assert.notEqual(after.leadNextActionOwnerId, tele.id, "never the Telecaller's");

    const bell = await db.select().from(notifications).where(eq(notifications.userId, pritesh.id));
    assert.ok(bell.some((n) => /ready to verify/.test(n.title)), "they are told");

    asPritesh();
    const v = await verify(lead.id);
    assert.equal(v.ok, true, v.ok ? "" : v.error);
    const opened = await row(lead.id);
    assert.equal(opened.leadStage, "qualification");
    assert.equal(opened.leadVerifiedById, pritesh.id);
    assert.equal(opened.leadNextActionOwnerId, tele.id, "Qualification opens as the Telecaller's");
  });

  test("2. an ORG-CHART seat (sales_manager_decided_at null) does not stop it - the designated verifier still wins", async () => {
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    // What `recomputeSalesManagers` writes: a seat on a Telecaller's lead, no decision mark.
    const lead = await makeSuspect({ salesManagerId: seema.id, salesManagerDecidedAt: null });
    assert.equal(await isTelecallerHandled(lead), true);

    asTele();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const after = await row(lead.id);
    assert.equal(after.leadNextActionOwnerId, pritesh.id, "strict: not the org-chart seat holder");
    assert.equal(after.salesManagerId, seema.id, "sales_manager_id is left exactly as the org chart wrote it");
    assert.equal(after.salesManagerDecidedAt, null, "and no decision is invented for it");

    asPritesh();
    const v = await verify(lead.id);
    assert.equal(v.ok, true, v.ok ? "" : v.error);
  });

  test("2b. an unowned lead with no decided seat is a Telecaller's too", async () => {
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    const lead = await makeSuspect({ ownerId: null, leadManagerId: null, backOfficeAmId: tele.id });
    asTele();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadNextActionOwnerId, pritesh.id);
  });

  test("3. no manager covers the region: the designated verifier, NOT the old region error", async () => {
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    await cover(mgr.id, "Kerala"); // the only manager covers somewhere else
    const lead = await makeSuspect({ territoryRegion: "Maharashtra" });
    asTele();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadNextActionOwnerId, pritesh.id);
  });

  test("4. there is nothing to choose: no verifier field on the action, no dropdown on the desk", async () => {
    const action = readFileSync("src/lib/actions/lead-calling-desk.ts", "utf8");
    const schema = action.slice(action.indexOf("const requestSchema"), action.indexOf("async function preparePromotion"));
    assert.doesNotMatch(schema, /managerId|verifierId/, "the conversion takes no verifier");
    const dialogs = readFileSync("src/components/leads/calling-desk/dialogs.tsx", "utf8");
    assert.doesNotMatch(dialogs, /who verifies it/i, "no verifier picker on the Convert dialog");
    assert.doesNotMatch(dialogs, /AssignLeadManager|assignLeadManager/);
  });

  test("5. no Assign Lead Manager step: the seat is filled without a decision or an assignment record", async () => {
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    const lead = await makeSuspect();
    asTele();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const seated = await row(lead.id);
    assert.equal(seated.leadManagerDecidedAt, null);
    const audits = (await db.select().from(auditLog).where(eq(auditLog.entityId, lead.id))).map((a) => a.action);
    assert.ok(!audits.includes("lead.manager.assign"), `no assignment was made: ${audits.join(",")}`);
  });

  test("owner classification: only a Calling-desk worker (or nobody) owns a Telecaller's lead", async () => {
    assert.equal(await isTelecallerHandled({ ownerId: tele.id }), true, "a desk worker");
    assert.equal(await isTelecallerHandled({ ownerId: null }), true, "nobody");
    assert.equal(await isTelecallerHandled({ ownerId: salesman.id }), false, "a field salesman");
    assert.equal(await isTelecallerHandled({ ownerId: seema.id }), false, "a Sales Manager (explicit module row)");
    assert.equal(await isTelecallerHandled({ ownerId: mgr.id }), false, "a manager (lead.verify)");
    assert.equal(await isTelecallerHandled({ ownerId: pritesh.id }), false, "an administrator");
    const both = await makeUser("Both Hats", "associate", [["crm", "associate"], ["field", "associate"]], ["crm.lead-calling-desk"]);
    assert.equal(await isTelecallerHandled({ ownerId: both.id }), false, "a desk worker who also holds field is read as field");
  });
});

/* ═══════════════════════ B — a lead a Sales Manager raised herself (kept apart) */

describe("B: a Sales Manager's own lead keeps ITS mechanism, and A's setting does not touch it", () => {
  const selfRaisedAtTheDesk = async () => {
    // She raised it and owns it, and she works the desk too, so she can convert it.
    await db.insert(appModuleAccess).values({ id: id("ama"), userId: seema.id, app: "crm", module: "crm.lead-calling-desk" });
    return makeSuspect({ ownerId: seema.id, salesManagerId: seema.id, salesManagerDecidedAt: new Date() });
  };

  test("6. a self-raised lead goes to the self-raised approver", async () => {
    await setting("leads.selfRaisedVerifierEmail", pritesh.email!);
    const lead = await selfRaisedAtTheDesk();
    assert.equal(await isTelecallerHandled(lead), false, "the owner is the Sales Manager, the seat is decided");
    asSeema();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadNextActionOwnerId, pritesh.id);
  });

  test("7. the Telecaller setting does NOT override a self-raised lead", async () => {
    await setting("leads.selfRaisedVerifierEmail", pritesh.email!);
    await setting("leads.telecallerVerifierEmail", mgr.email!); // somebody ELSE
    const lead = await selfRaisedAtTheDesk();
    asSeema();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadNextActionOwnerId, pritesh.id, "still the self-raised approver");
    assert.equal(await telecallerRouteFor(lead, tele.id).then((x) => x.kind), "off");
  });

  test("captured by her at intake, it is seated on the self-raised approver and is not a Telecaller's", async () => {
    await setting("leads.selfRaisedVerifierEmail", pritesh.email!);
    await setting("leads.telecallerVerifierEmail", mgr.email!);
    asSeema();
    const made = await captureLead({
      salesType: "direct",
      name: "J P paints and hardware stores",
      phone: "9876501234",
      city: "Nashik",
      source: "telecalling",
    } as never);
    assert.ok(made.ok, made.ok ? "" : made.error);
    const lead = await row(made.data.customerId);
    assert.equal(lead.salesManagerId, seema.id);
    assert.ok(lead.salesManagerDecidedAt, "a person set this seat");
    assert.equal(lead.leadManagerId, pritesh.id, "seated on the designated approver at capture");
    assert.equal(await isTelecallerHandled(lead), false);
  });

  test("the self-raised setting does not turn a Telecaller's lead into one", async () => {
    await setting("leads.selfRaisedVerifierEmail", pritesh.email!);
    const lead = await makeSuspect();
    asTele();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadNextActionOwnerId, mgr.id, "not Pritesh: that setting is not for this lead");
  });
});

/* ═════════════════════════ C — salesman-owned and decided leads: routing unchanged */

describe("C: a salesman's lead, and anything a person decided, keep the routing they had", () => {
  /** Converts the same kind of lead with the Telecaller setting blank and then ON; returns both owners. */
  const bothWays = async (over: Partial<typeof customers.$inferInsert>) => {
    const first = await makeSuspect({ backOfficeAmId: tele.id, ...over });
    asTele();
    const a = await convert(first.id);
    const before = a.ok ? (await row(first.id)).leadNextActionOwnerId : a.error;

    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    const second = await makeSuspect({ backOfficeAmId: tele.id, ...over });
    asTele();
    const b = await convert(second.id);
    const after = b.ok ? (await row(second.id)).leadNextActionOwnerId : b.error;
    return { before, after, rowAfter: b.ok ? await row(second.id) : null };
  };

  test("8. a salesman-owned lead: the existing routing, unchanged by the setting", async () => {
    assert.equal(await isTelecallerHandled({ ownerId: salesman.id }), false);
    const r = await bothWays({ ownerId: salesman.id });
    assert.equal(r.before, mgr.id);
    assert.equal(r.after, r.before);
    assert.notEqual(r.after, pritesh.id, "no global default");
  });

  test("9. a salesman's lead with a regional Sales Manager: that manager, as before", async () => {
    await cover(mgr.id, "Maharashtra");
    const r = await bothWays({ ownerId: salesman.id, territoryRegion: "Maharashtra" });
    assert.equal(r.before, mgr.id);
    assert.equal(r.after, r.before);
  });

  test("10. a salesman's lead with no regional coverage: the same refusal, as before", async () => {
    await cover(mgr.id, "Kerala");
    const r = await bothWays({ ownerId: salesman.id, territoryRegion: "Maharashtra" });
    assert.match(String(r.before), NO_REGION);
    assert.equal(r.after, r.before, "the setting did not paper over it");
  });

  test("11. a Sales Manager seat a PERSON decided is not the Telecaller workflow", async () => {
    const decided = { ownerId: tele.id, salesManagerId: seema.id, salesManagerDecidedAt: new Date() };
    assert.equal(await isTelecallerHandled(decided), false);
    const r = await bothWays(decided);
    assert.equal(r.before, seema.id, "the seat holder verifies");
    assert.equal(r.after, seema.id);
    assert.equal(r.rowAfter?.salesManagerId, seema.id, "sales_manager_id is untouched");
  });

  test("12. a lead manager somebody CHOSE keeps them, and the decision stands", async () => {
    const chosen = await makeUser("Chosen Manager", "manager", [["crm", "manager"]]);
    const over = { leadManagerId: chosen.id, leadManagerDecidedAt: new Date() };
    assert.equal(await isTelecallerHandled({ ownerId: tele.id, ...over }), false);
    const r = await bothWays(over);
    assert.equal(r.before, chosen.id);
    assert.equal(r.after, chosen.id);
    assert.equal(r.rowAfter?.leadManagerId, chosen.id);
    assert.ok(r.rowAfter?.leadManagerDecidedAt, "and its decision mark with it");
  });
});

/* ═════════════════════════════════════════════════ safety: blank, broken, self */

describe("Safety: nothing is chosen silently, and a broken setting says so", () => {
  test("13. blank: no designated verifier is invented - routing and the region refusal are as before", async () => {
    assert.equal((await telecallerRouteFor({ ownerId: tele.id }, tele.id)).kind, "off");

    // with a manager: the ordinary answer, not anybody designated
    const a = await makeSuspect();
    asTele();
    assert.equal((await convert(a.id)).ok, true);
    assert.equal((await row(a.id)).leadNextActionOwnerId, mgr.id);

    // with nobody covering: the old refusal, and the lead stays a Suspect
    await cover(mgr.id, "Kerala");
    const b = await makeSuspect({ territoryRegion: "Maharashtra" });
    const r = await convert(b.id);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, NO_REGION);
    assert.equal((await row(b.id)).leadStage, "suspect");
  });

  test("14a. a designated account that is INACTIVE refuses, in words, and the lead stays a Suspect", async () => {
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    await db.update(users).set({ active: false }).where(eq(users.id, pritesh.id));
    const lead = await makeSuspect();
    asTele();
    const r = await convert(lead.id);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /Nobody can verify this lead yet[\s\S]*no active account/);
    assert.equal((await row(lead.id)).leadStage, "suspect");
  });

  test("14b. a name that matches nobody refuses the same way - it is not routed to the region instead", async () => {
    await setting("leads.telecallerVerifierEmail", "nobody@nowhere.test");
    const lead = await makeSuspect();
    asTele();
    const r = await convert(lead.id);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /no active account/);
    assert.equal((await row(lead.id)).leadStage, "suspect");
    assert.equal((await row(lead.id)).leadNextActionOwnerId, null, "and nobody else was given it");
  });

  test("14c. somebody WITHOUT lead.verify refuses, naming them", async () => {
    await setting("leads.telecallerVerifierEmail", bystander.email!);
    const lead = await makeSuspect();
    asTele();
    const r = await convert(lead.id);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /Bina Bystander[\s\S]*does not hold the verification permission/);
    assert.equal((await row(lead.id)).leadStage, "suspect");
  });

  test("14d. the setting is only consulted for a Telecaller's lead: a salesman's lead is not refused by a broken one", async () => {
    await setting("leads.telecallerVerifierEmail", "nobody@nowhere.test");
    const lead = await makeSuspect({ ownerId: salesman.id, backOfficeAmId: tele.id });
    asTele();
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadNextActionOwnerId, mgr.id);
  });

  test("15. the designated verifier cannot be the one who converts it", async () => {
    await setting("leads.telecallerVerifierEmail", pritesh.email!);
    const lead = await makeSuspect();
    asPritesh();
    const r = await convert(lead.id);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /cannot also convert this one/);
    assert.equal((await row(lead.id)).leadStage, "suspect");
    assert.equal((await telecallerRouteFor(lead, pritesh.id)).kind, "refuse");
  });
});
