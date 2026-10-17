/**
 * A LEAD STILL AT THE OLD `new` / `contacted` STAGE CONVERTS TO PROSPECT.
 *
 * The desk gives such a lead a sales type and then moves it to Prospect; the move is
 * judged against the lead's own ladder, and the funnel ladders start at `suspect`.
 * It used to be refused with "Prospect is not a rung on this lead's ladder". Now the
 * desk relabels the lead as the Suspect it already is, in the same save.
 *
 * Real actions against `mahekone_test`.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, auditLog, customers, leadStageTransitions, products, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { convertLeadToProspect, requestProspect } from "@/lib/actions/lead-calling-desk";
import { QUAL_NEXT } from "@/lib/services/lead-qualification-flow-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let tele: typeof users.$inferSelect;
let mgr: typeof users.$inferSelect;
let productId: string;

async function makeUser(name: string, role: "associate" | "manager", modules: string[] = []) {
  const [u] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.replace(/\W/g, "").toLowerCase()}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "crm", role });
  for (const m of modules) await db.insert(appModuleAccess).values({ id: id("ama"), userId: u.id, app: "crm", module: m });
  return u;
}

async function makeLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [l] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      contactPerson: "Ganesh",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Thane",
      kind: "lead",
      leadStage: "new",
      leadSalesType: null,
      leadSource: "manual",
      ownerId: tele.id,
      leadDecisionMaker: "Owner",
      leadMonthlyVolumeLitres: 200,
      leadRequiredProductId: productId,
      leadCompetitor: "no one",
      ...over,
    })
    .returning();
  return l;
}

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const convert = (customerId: string, salesType?: "direct" | "third_party") =>
  convertLeadToProspect({ customerId, reasonCode: "regular_requirement", customerType: "manufacturer", salesType });

before(() => assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first."));
after(async () => {
  setTestUser(null);
  await db.$client.end();
});
beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_stage_transitions, notifications, timeline_events, audit_log, app_module_access, app_access,
      mbos_user_territories, calls, customers, products, users, app_settings restart identity cascade`);
  invalidateConfig();
  await seedConfig();
  tele = await makeUser("Tara Telecaller", "associate", ["crm.lead-calling-desk"]);
  mgr = await makeUser("Manoj Manager", "manager");
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
  setTestUser(tele);
});

describe("a lead at the legacy stage is relabelled, not refused", () => {
  for (const stage of ["new", "contacted"] as const) {
    test(`${stage}: no sales type yet, the desk picks Direct - it converts`, async () => {
      const lead = await makeLead({ leadStage: stage });
      const r = await convert(lead.id, "direct");
      assert.equal(r.ok, true, r.ok ? "" : r.error);
      const after = await row(lead.id);
      assert.equal(after.leadStage, "prospect");
      assert.equal(after.leadSalesType, "direct");
      assert.equal(after.leadNextAction, QUAL_NEXT.verify);
      assert.equal(after.leadNextActionOwnerId, mgr.id, "routed as any lead is");
    });
  }

  test("Third party works the same", async () => {
    const lead = await makeLead({ leadStage: "contacted" });
    const r = await convert(lead.id, "third_party");
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadSalesType, "third_party");
  });

  test("a sales type that was already set, on a lead still at the old stage, converts too", async () => {
    const lead = await makeLead({ leadStage: "new", leadSalesType: "direct" });
    const r = await convert(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadStage, "prospect");
  });

  test("the relabel is audited, and is not recorded as a move up the ladder", async () => {
    const lead = await makeLead({ leadStage: "new" });
    assert.equal((await convert(lead.id, "direct")).ok, true);
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, lead.id));
    const relabel = audits.find((a) => a.action === "lead.stage.relabel");
    assert.ok(relabel, `audit rows: ${audits.map((a) => a.action).join(",")}`);
    assert.deepEqual((relabel.beforeState as { stage: string }).stage, "new");
    assert.deepEqual((relabel.afterState as { stage: string }).stage, "suspect");
    const moves = await db.select().from(leadStageTransitions).where(eq(leadStageTransitions.customerId, lead.id));
    assert.deepEqual(
      moves.map((m) => `${m.fromStage}>${m.toStage}`),
      ["suspect>prospect"],
      "one real move; the relabel is not a step forward",
    );
  });

  test("the request path (direct promotion off) relabels the same way", async () => {
    const lead = await makeLead({ leadStage: "contacted" });
    setTestUser(tele);
    const r = await requestProspect({ customerId: lead.id, reasonCode: "regular_requirement", customerType: "manufacturer", salesType: "direct" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadStage, "suspect", "still awaiting verification, now under a name the ladder knows");
  });
});

describe("nothing else changes", () => {
  test("a lead already at Suspect is untouched: no relabel, no extra audit row", async () => {
    const lead = await makeLead({ leadStage: "suspect" });
    assert.equal((await convert(lead.id, "direct")).ok, true);
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, lead.id));
    assert.ok(!audits.some((a) => a.action === "lead.stage.relabel"));
  });

  test("a refusal that is not about the stage still refuses, and leaves the old stage alone", async () => {
    const lead = await makeLead({ leadStage: "new", leadMonthlyVolumeLitres: null });
    const r = await convert(lead.id, "direct");
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadStage, "new", "nothing was written");
  });
});
