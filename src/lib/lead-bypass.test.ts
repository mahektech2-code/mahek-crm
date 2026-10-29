/**
 * The Accounts bypass — a lead converted straight to a customer — against
 * mahekone_test with the REAL action.
 *
 *   C  the conversion changes the account everywhere: kind, stage, dates,
 *      third-party mark, seats, details, contacts — and records what it skipped;
 *   W  only an Accounts manager or admin, and only from the Accounts app;
 *   R  the refusals: already a customer, a number or GSTIN in use, a GSTIN from
 *      another state, no CONVERT.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  auditLog,
  customerContacts,
  customers,
  leadStageTransitions,
  mbosDeletions,
  timelineEvents,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { setTestCustomerEditApp } from "@/lib/customer-edit-gate";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { bypassConvertLead, loadLeadForBypass, searchLeadsForBypass } from "@/lib/actions/lead-bypass";
import type { BypassInput } from "@/lib/lead-bypass";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type Level = "associate" | "manager" | "admin";

async function makeUser(name: string, role: Level, apps: { app: "crm" | "accounts"; role: Level }[]) {
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
  for (const a of apps) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: a.app, role: a.role });
  return row;
}

async function makeLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: "Shop F Industries",
      contactPerson: "Person F",
      phone: "9811100011",
      city: "Nagpur",
      kind: "lead",
      leadSalesType: "direct",
      leadStage: "qualification",
      thirdParty: true,
      ...over,
    })
    .returning();
  return row;
}

const record = async (customerId: string) =>
  (await db.select().from(customers).where(eq(customers.id, customerId)))[0];

let manager: typeof users.$inferSelect;
let telecaller: typeof users.$inferSelect;

function input(leadId: string, over: Partial<BypassInput> = {}): BypassInput {
  return {
    leadId,
    name: "Shop F Industries Pvt Ltd",
    contactPerson: "Person F",
    phone: "9811100011",
    whatsappPhone: "",
    email: "",
    customerType: "manufacturer",
    // A real, valid Maharashtra GSTIN shape — check digit included.
    gstin: "27AAPFU0939F1ZV",
    gstNotRegistered: false,
    gstNotRegisteredReason: "",
    address: "Plot 12, MIDC Hingna",
    city: "Nagpur",
    state: "Maharashtra",
    sales: { kind: "user", userId: telecaller.id },
    backOffice: { kind: "none" },
    salesManager: { kind: "none" },
    creditTermDays: 30,
    creditLimitPaise: null,
    priceTag: "Maharashtra Dealer",
    freightTerm: "to_pay",
    deliveryType: "Door Delivery",
    reasonCode: "order_today",
    note: "Owner confirmed 40 cans on the phone.",
    confirm: "CONVERT",
    ...over,
  };
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table customer_contacts, audit_log, notifications, app_module_access, app_access,
      lead_stage_transitions, timeline_events, mbos_deletions, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  manager = await makeUser("Mira Manager", "manager", [{ app: "accounts", role: "manager" }]);
  telecaller = await makeUser("Tara Telecaller", "associate", [{ app: "crm", role: "associate" }]);
  setTestUser(manager);
  setTestCustomerEditApp("accounts");
});

after(async () => {
  setTestUser(null);
  setTestCustomerEditApp(null);
  await db.$client.end();
});

describe("C — the conversion reaches everything", () => {
  test("the lead becomes a customer, with every column and record moved", async () => {
    const lead = await makeLead({ ownerId: null });

    const result = await bypassConvertLead(input(lead.id));
    assert.ok(result.ok, result.ok ? "" : result.error);

    const c = await record(lead.id);
    assert.equal(c.kind, "customer");
    assert.equal(c.leadStage, "won");
    assert.ok(c.customerSince);
    assert.ok(c.leadConvertedAt);
    assert.equal(c.thirdParty, false);
    assert.equal(c.status, "active");
    assert.equal(c.name, "Shop F Industries Pvt Ltd");
    assert.equal(c.customerType, "manufacturer");
    assert.equal(c.gstin, "27AAPFU0939F1ZV");
    assert.equal(c.address, "Plot 12, MIDC Hingna");
    assert.equal(c.region, "Maharashtra");
    assert.equal(c.creditTermDays, 30);
    assert.equal(c.creditDays, 30);
    assert.equal(c.priceTag, "Maharashtra Dealer");
    assert.equal(c.freightTerm, "to_pay");
    assert.equal(c.deliveryType, "Door Delivery");
    assert.equal(c.salesAmId, telecaller.id);
    assert.equal(c.ownerId, telecaller.id);
    assert.equal(c.salesPersonName, "Tara Telecaller");
    assert.ok(c.amDecidedAt, "the seats are a decision the sheet must keep off");

    const [move] = await db.select().from(leadStageTransitions).where(eq(leadStageTransitions.customerId, lead.id));
    assert.equal(move.kind, "overridden");
    assert.equal(move.fromStage, "qualification");
    assert.equal(move.toStage, "won");
    assert.equal(move.reasonCode, "order_today");
    assert.ok(move.overriddenConditions.includes("stage:qualification"));
    assert.ok(move.overriddenConditions.includes("stage:second_order"));
    assert.ok(!move.overriddenConditions.includes("stage:prospect"), "Prospect was already behind it");

    const audits = await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, lead.id));
    assert.deepEqual(audits.map((a) => a.action).sort(), ["customer.bypassConvert", "customer.convertedFromLead"]);

    const timeline = await db.select().from(timelineEvents).where(eq(timelineEvents.customerId, lead.id));
    assert.ok(timeline.some((t) => t.summary.includes("bypassed in Accounts")));

    const tomb = await db
      .select()
      .from(mbosDeletions)
      .where(and(eq(mbosDeletions.entity, "leads"), eq(mbosDeletions.entityId, lead.id)));
    assert.equal(tomb.length, 1, "handsets are told the lead stopped being one");

    const contacts = await db.select().from(customerContacts).where(eq(customerContacts.customerId, lead.id));
    assert.ok(contacts.some((x) => x.isPrimary && x.phone === "9811100011"));
  });

  test("a shop with no GSTIN converts when it says why", async () => {
    const lead = await makeLead();
    const result = await bypassConvertLead(
      input(lead.id, { gstin: "", gstNotRegistered: true, gstNotRegisteredReason: "Turnover below the limit" }),
    );
    assert.ok(result.ok, result.ok ? "" : result.error);
    assert.equal((await record(lead.id)).gstin, null);
  });

  test("the form starts from the lead's own answers and lists what is skipped", async () => {
    const lead = await makeLead({ region: "Maharashtra", priceTag: "MH Dealer", ownerId: telecaller.id });
    await makeLead({ id: id("cus"), name: "Other", phone: "9811100099", priceTag: "MH Dealer" });
    const loaded = await loadLeadForBypass(lead.id);
    assert.ok(loaded.ok);
    assert.equal(loaded.data.values.state, "Maharashtra");
    assert.equal(loaded.data.values.sales, telecaller.id);
    assert.deepEqual(loaded.data.funnel.passed.map((s) => s.stage), ["suspect", "prospect"]);
    assert.equal(loaded.data.funnel.skipped[0].stage, "qualification");
    assert.ok(loaded.data.priceTags.includes("MH Dealer"));

    const found = await searchLeadsForBypass("shop f");
    assert.ok(found.ok);
    assert.ok(found.data.some((h) => h.id === lead.id));
  });
});

describe("W — who, and where", () => {
  test("refused outside the Accounts app", async () => {
    const lead = await makeLead();
    setTestCustomerEditApp("crm");
    const result = await bypassConvertLead(input(lead.id));
    assert.equal(result.ok, false);
    assert.equal((await record(lead.id)).kind, "lead");
  });

  test("refused for an Accounts associate", async () => {
    const lead = await makeLead();
    const clerk = await makeUser("Cara Clerk", "associate", [{ app: "accounts", role: "associate" }]);
    setTestUser(clerk);
    const result = await bypassConvertLead(input(lead.id));
    assert.equal(result.ok, false);
    assert.equal((await record(lead.id)).kind, "lead");
  });
});

describe("S — the sales manager seat", () => {
  test("an Accounts manager sets it, over the one the lead already carried", async () => {
    const lead = await makeLead({ salesManagerId: telecaller.id, salesManagerPersonName: telecaller.name });
    const result = await bypassConvertLead(input(lead.id, { salesManager: { kind: "user", userId: manager.id } }));
    assert.ok(result.ok, result.ok ? "" : result.error);
    assert.equal((await record(lead.id)).salesManagerId, manager.id);
  });

  test("the lead's own seat sent back unchanged is kept", async () => {
    const lead = await makeLead({ salesManagerId: telecaller.id, salesManagerPersonName: telecaller.name });
    const result = await bypassConvertLead(input(lead.id, { salesManager: { kind: "user", userId: telecaller.id } }));
    assert.ok(result.ok, result.ok ? "" : result.error);
    assert.equal((await record(lead.id)).salesManagerId, telecaller.id);
  });
});

describe("R — refusals", () => {
  test("an account that is already a customer", async () => {
    const lead = await makeLead({ kind: "customer" });
    const result = await bypassConvertLead(input(lead.id));
    assert.equal(result.ok, false);
  });

  test("a mobile another account uses", async () => {
    await makeLead({ id: id("cus"), name: "Somebody else", kind: "customer", phone: "9811100055" });
    const lead = await makeLead();
    const result = await bypassConvertLead(input(lead.id, { phone: "9811100055" }));
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.fieldErrors?.[0]?.field, "phone");
  });

  test("a GSTIN registered in another state", async () => {
    const lead = await makeLead();
    const result = await bypassConvertLead(input(lead.id, { state: "Gujarat" }));
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.fieldErrors?.[0]?.field, "state");
  });

  test("CONVERT not typed", async () => {
    const lead = await makeLead();
    const result = await bypassConvertLead(input(lead.id, { confirm: "yes" }));
    assert.equal(result.ok, false);
    assert.equal((await record(lead.id)).kind, "lead");
  });
});
