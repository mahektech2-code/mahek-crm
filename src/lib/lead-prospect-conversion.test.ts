/**
 *   npm run test:integration
 *
 * A Suspect becomes a Prospect only when ALL SEVEN answers are in and each is a
 * real one — through every door. Real actions, real services, mahekone_test.
 *
 *   1  all seven valid → the authorised workflow runs;
 *   2  any one missing, several missing, blank, invalid → blocked, and nothing is
 *      written: no stage, no transition, no request, no half-saved answer;
 *   3  the direct-promotion switch off → a request still needs all seven;
 *   4  the generic stage move and a manager's override cannot get round it, and
 *      neither can switching `leads.requireNextAction` off;
 *   5  what the record already holds counts and is not overwritten.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, leadStageTransitions, products, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig, updateSetting } from "@/lib/config/store";
import { convertLeadToProspect, requestProspect } from "@/lib/actions/lead-calling-desk";
import { advanceLeadStage } from "@/lib/actions/leads";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const FUTURE = "2026-12-01";

let desk: typeof users.$inferSelect;
let manager: typeof users.$inferSelect;
let productId: string;

async function makeUser(name: string, role: "associate" | "manager") {
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
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role });
  return row;
}

/** A Suspect with NOTHING answered, so each test supplies exactly what it means to. */
async function bareLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nashik",
      kind: "lead",
      leadStage: "suspect",
      leadSalesType: "direct",
      leadSource: "Website / Online Enquiry",
      ownerId: desk.id,
      ...over,
    })
    .returning();
  return row;
}

/** Every answer (the two optional ones included), as the dialog would send them for a lead that has none on the record. */
const full = (customerId: string): Parameters<typeof convertLeadToProspect>[0] => ({
  customerId,
  reasonCode: "regular_requirement",
  customerType: "retailer",
  monthlyLitres: 1000,
  competitor: "Ashoka",
  requiredProductId: productId,
  contactPerson: "Mr Shashi Gupta",
  gstin: "27ABCDE1234F1Z5",
  nextAction: "Call back with the price list",
  nextActionDate: FUTURE,
});

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0]!;
const moves = async (leadId: string) =>
  db.select().from(leadStageTransitions).where(eq(leadStageTransitions.customerId, leadId));

/** Nothing moved, nothing filed, nothing half-saved. */
async function assertUntouched(leadId: string) {
  const r = await row(leadId);
  assert.equal(r.leadStage, "suspect", "the stage did not move");
  assert.equal(r.prospectRequestState, null, "no request was filed");
  assert.equal((await moves(leadId)).length, 0, "no transition was written");
  assert.equal(r.leadMonthlyVolumeLitres, null, "no answer was half-saved");
  assert.equal(r.leadCompetitor, null);
  assert.equal(r.leadRequiredProductId, null);
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against mahekone_test.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_stage_transitions, lead_verification_corrections, mbos_lead_validations, mbos_tasks,
      calls, notifications, timeline_events, audit_log, app_access, customers, products, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  desk = await makeUser("Desk Caller", "associate");
  manager = await makeUser("Sales Manager", "manager");
  await db.insert(appAccess).values({ id: id("aca"), userId: manager.id, app: "sales", role: "manager" });
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
  setTestUser(desk);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("all valid", () => {
  test("a lead with nothing on the record converts when the request carries every answer", async () => {
    const lead = await bareLead();
    const r = await convertLeadToProspect(full(lead.id));
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect");
    assert.equal(after.customerType, "retailer");
    assert.equal(after.leadMonthlyVolumeLitres, 1000);
    assert.equal(after.leadCompetitor, "Ashoka");
    assert.equal(after.leadRequiredProductId, productId);
    assert.equal(after.contactPerson, "Mr Shashi Gupta");
    const t = await moves(lead.id);
    assert.equal(t.length, 1);
    assert.equal(t[0]!.reasonCode, "regular_requirement");
    assert.equal(t[0]!.actorId, desk.id, "the telecaller's own act");
    assert.equal(after.leadNextActionOwnerId, manager.id, "the verification is the manager's, as it always was");
  });

  test("a second press on a converted lead is refused: no double conversion", async () => {
    const lead = await bareLead();
    assert.equal((await convertLeadToProspect(full(lead.id))).ok, true);
    const again = await convertLeadToProspect(full(lead.id));
    assert.equal(again.ok, false);
    assert.equal((await moves(lead.id)).length, 1);
  });
});

describe("any one answer missing blocks, and nothing is written", () => {
  const drop: Array<[string, (keyof ReturnType<typeof full>)[], RegExp]> = [
    ["business type", ["customerType"], /kind of business/i],
    ["monthly litres", ["monthlyLitres"], /litres/i],
    ["competitor", ["competitor"], /brand/i],
    ["product", ["requiredProductId"], /product/i],
    ["GST number", ["gstin"], /gst/i],
    ["next action", ["nextAction", "nextActionDate"], /next/i],
    ["next action day only", ["nextActionDate"], /when|date|day/i],
  ];
  for (const [name, keys, message] of drop) {
    test(name, async () => {
      const lead = await bareLead();
      const payload = { ...full(lead.id) } as Record<string, unknown>;
      for (const k of keys) delete payload[k as string];
      const r = await convertLeadToProspect(payload as never);
      assert.equal(r.ok, false);
      assert.match(!r.ok ? r.error : "", message);
      await assertUntouched(lead.id);
    });
  }

  test("several missing: every one is named in the field errors", async () => {
    const lead = await bareLead();
    const r = await convertLeadToProspect({ customerId: lead.id, reasonCode: "regular_requirement" });
    assert.equal(r.ok, false);
    const fields = new Set((!r.ok ? (r.fieldErrors ?? []) : []).map((f) => f.field));
    for (const f of ["customerType", "monthlyLitres", "competitor", "requiredProductId", "gstin", "nextAction", "nextActionDate"]) {
      assert.ok(fields.has(f), `${f} is named`);
    }
    await assertUntouched(lead.id);
  });
});

describe("blank and invalid answers block", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["whitespace competitor", { competitor: "     " }],
    ["a GST number past the 20-character limit", { gstin: "x".repeat(21) }],
    ["whitespace next action", { nextAction: "   " }],
    ["one-letter competitor", { competitor: "x" }],
    ["a contact person that is only digits", { contactPerson: "9820011234" }],
    ["zero litres", { monthlyLitres: 0 }],
    ["negative litres", { monthlyLitres: -40 }],
    ["absurd litres", { monthlyLitres: 50_000_000 }],
    ["a business type that is not listed", { customerType: "banana" }],
    ["a next-step day that is not a day", { nextActionDate: "2026-02-31" }],
    ["a next-step day in the past", { nextActionDate: "2020-01-01" }],
    ["a reason that is not configured", { reasonCode: "because" }],
    ["a product the catalogue does not hold", { requiredProductId: "prd_does_not_exist" }],
  ];
  for (const [name, patch] of bad) {
    test(name, async () => {
      const lead = await bareLead();
      const r = await convertLeadToProspect({ ...full(lead.id), ...patch } as never);
      assert.equal(r.ok, false, "refused");
      await assertUntouched(lead.id);
    });
  }

  test("an invalid value already on the record does not count, and is refused unless replaced", async () => {
    const lead = await bareLead({ leadMonthlyVolumeLitres: 0, leadCompetitor: "x" });
    const payload = { ...full(lead.id) } as Record<string, unknown>;
    delete payload.monthlyLitres;
    delete payload.competitor;
    const refused = await convertLeadToProspect(payload as never);
    assert.equal(refused.ok, false);
    assert.equal((await row(lead.id)).leadStage, "suspect");
    const replaced = await convertLeadToProspect(full(lead.id));
    assert.equal(replaced.ok, true, replaced.ok ? "" : replaced.error);
    assert.equal((await row(lead.id)).leadMonthlyVolumeLitres, 1000);
  });
});

describe("what the record already holds counts, and is not overwritten", () => {
  test("valid answers on the record are not asked again, and a supplied different value does not replace them", async () => {
    const lead = await bareLead({
      customerType: "manufacturer",
      contactPerson: "Ganesh",
      gstin: "27ABCDE1234F1Z5",
      leadMonthlyVolumeLitres: 200,
      leadCompetitor: "Local thinner",
      leadRequiredProductId: productId,
      leadNextAction: "Call 2",
      leadNextActionDate: FUTURE,
      leadNextActionOwnerId: desk.id,
    });
    const r = await convertLeadToProspect({
      customerId: lead.id,
      reasonCode: "regular_requirement",
      competitor: "Somebody else",
      monthlyLitres: 9999,
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadCompetitor, "Local thinner");
    assert.equal(after.leadMonthlyVolumeLitres, 200);
    assert.equal(after.customerType, "manufacturer");
    assert.equal(after.contactPerson, "Ganesh");
  });

  test("a record with all valid answers needs nothing more — the reason is optional", async () => {
    const lead = await bareLead({
      customerType: "manufacturer",
      contactPerson: "Ganesh",
      gstin: "27ABCDE1234F1Z5",
      leadMonthlyVolumeLitres: 200,
      leadCompetitor: "Local thinner",
      leadRequiredProductId: productId,
      leadNextAction: "Call 2",
      leadNextActionDate: FUTURE,
      leadNextActionOwnerId: desk.id,
    });
    const r = await convertLeadToProspect({ customerId: lead.id, reasonCode: "" } as never);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadStage, "prospect");
  });

  test("an existing GST number is never overwritten by one the dialog supplies", async () => {
    const lead = await bareLead({
      customerType: "manufacturer",
      contactPerson: "Ganesh",
      gstin: "27ABCDE1234F1Z5",
      leadMonthlyVolumeLitres: 200,
      leadCompetitor: "Local thinner",
      leadRequiredProductId: productId,
      leadNextAction: "Call 2",
      leadNextActionDate: FUTURE,
      leadNextActionOwnerId: desk.id,
    });
    const r = await convertLeadToProspect({ customerId: lead.id, reasonCode: "regular_requirement", gstin: "29ZZZZZ9999Z1Z1" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).gstin, "27ABCDE1234F1Z5");
  });
});

describe("who to ask for and why it is worth following up are OPTIONAL — and the GST number is not", () => {
  test("a request with neither converts; the contact stays empty and no reason is recorded", async () => {
    const lead = await bareLead();
    const payload = { ...full(lead.id) } as Record<string, unknown>;
    delete payload.contactPerson;
    delete payload.reasonCode;
    const r = await convertLeadToProspect(payload as never);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect");
    assert.equal(after.contactPerson, null);
    assert.equal((await moves(lead.id))[0]!.reasonCode, null);
  });

  test("blank strings for both convert too", async () => {
    const lead = await bareLead();
    const r = await convertLeadToProspect({ ...full(lead.id), contactPerson: "", reasonCode: "" } as never);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  test("a GIVEN reason must still be a listed one, and a given contact a real name", async () => {
    const a = await bareLead();
    assert.equal((await convertLeadToProspect({ ...full(a.id), reasonCode: "because" } as never)).ok, false);
    const b = await bareLead();
    assert.equal((await convertLeadToProspect({ ...full(b.id), contactPerson: "9820011234" } as never)).ok, false);
  });

  test("the GST number is written onto the one column when the record had none", async () => {
    const lead = await bareLead();
    assert.equal(lead.gstin ?? null, null);
    const r = await convertLeadToProspect(full(lead.id));
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).gstin, "27ABCDE1234F1Z5");
  });

  test("without a GST number the Suspect cannot be a Prospect, by any door", async () => {
    const lead = await bareLead({ customerType: "retailer", contactPerson: "Ganesh", leadMonthlyVolumeLitres: 200, leadCompetitor: "Local thinner", leadRequiredProductId: productId, leadNextAction: "Call 2", leadNextActionDate: FUTURE, leadNextActionOwnerId: desk.id });
    const viaDesk = await convertLeadToProspect({ customerId: lead.id, reasonCode: "regular_requirement" });
    assert.equal(viaDesk.ok, false);
    const viaMove = await advanceLeadStage({ customerId: lead.id, to: "prospect", reasonCode: "regular_requirement" });
    assert.equal(viaMove.ok, false);
    assert.equal((await row(lead.id)).leadStage, "suspect");
  });
});

describe("direct promotion switched off: the verification request needs all seven too", () => {
  test("a complete request is filed, and the lead stays a Suspect", async () => {
    await updateSetting("leads.callingDeskDirectPromotion", false, manager.id);
    const lead = await bareLead();
    const r = await convertLeadToProspect(full(lead.id));
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "suspect");
    assert.equal(after.prospectRequestState, "awaiting");
    assert.equal(after.leadMonthlyVolumeLitres, 1000, "the answers given with the request are kept");
  });

  test("an incomplete request is blocked and files nothing", async () => {
    await updateSetting("leads.callingDeskDirectPromotion", false, manager.id);
    const lead = await bareLead();
    const payload = { ...full(lead.id) } as Record<string, unknown>;
    delete payload.competitor;
    const r = await convertLeadToProspect(payload as never);
    assert.equal(r.ok, false);
    await assertUntouched(lead.id);
  });

  test("requestProspect itself, called directly, is just as strict", async () => {
    const lead = await bareLead();
    const payload = { ...full(lead.id) } as Record<string, unknown>;
    delete payload.nextAction;
    delete payload.nextActionDate;
    const r = await requestProspect(payload as never);
    assert.equal(r.ok, false);
    await assertUntouched(lead.id);
  });
});

describe("no other door gets round it", () => {
  test("the generic stage move to Prospect is blocked while any answer is missing", async () => {
    const lead = await bareLead({ customerType: "retailer", contactPerson: "Ganesh" });
    const r = await advanceLeadStage({ customerId: lead.id, to: "prospect", reasonCode: "regular_requirement" });
    assert.equal(r.ok, false);
    await assertUntouched(lead.id);
  });

  test("the generic stage move works when every answer is on the record", async () => {
    const lead = await bareLead({
      customerType: "retailer",
      contactPerson: "Ganesh",
      gstin: "27ABCDE1234F1Z5",
      leadMonthlyVolumeLitres: 300,
      leadCompetitor: "Ashoka",
      leadRequiredProductId: productId,
      leadNextAction: "Call 2",
      leadNextActionDate: FUTURE,
      leadNextActionOwnerId: desk.id,
    });
    const r = await advanceLeadStage({ customerId: lead.id, to: "prospect", reasonCode: "regular_requirement" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadStage, "prospect");
  });

  test("the generic move rejects zero litres even though the gate calls any number an answer", async () => {
    const lead = await bareLead({
      customerType: "retailer",
      contactPerson: "Ganesh",
      gstin: "27ABCDE1234F1Z5",
      leadMonthlyVolumeLitres: 0,
      leadCompetitor: "Ashoka",
      leadRequiredProductId: productId,
      leadNextAction: "Call 2",
      leadNextActionDate: FUTURE,
      leadNextActionOwnerId: desk.id,
    });
    const r = await advanceLeadStage({ customerId: lead.id, to: "prospect", reasonCode: "regular_requirement" });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadStage, "suspect");
  });

  test("a manager's override cannot pass the closed gate to Prospect", async () => {
    const lead = await bareLead();
    setTestUser(manager);
    const r = await advanceLeadStage({
      customerId: lead.id,
      to: "prospect",
      reasonCode: "regular_requirement",
      override: { reasonCode: "management_decision", note: "Just do it." },
    });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadStage, "suspect");
    assert.equal((await moves(lead.id)).length, 0);
  });

  test("switching leads.requireNextAction off does not lift the next action for a Prospect", async () => {
    await updateSetting("leads.requireNextAction", false, manager.id);
    const lead = await bareLead({
      customerType: "retailer",
      contactPerson: "Ganesh",
      gstin: "27ABCDE1234F1Z5",
      leadMonthlyVolumeLitres: 300,
      leadCompetitor: "Ashoka",
      leadRequiredProductId: productId,
    });
    const r = await advanceLeadStage({ customerId: lead.id, to: "prospect", reasonCode: "regular_requirement" });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadStage, "suspect");
  });
});
