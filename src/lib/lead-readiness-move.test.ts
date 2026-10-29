import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  auditLog,
  customers,
  leadStageTransitions,
  mbosSamples,
  orders,
  products,
  users,
} from "@/db/schema";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { moveOnReadiness } from "@/lib/services/lead-readiness-move-service";
import type { LeadMoveActor } from "@/lib/services/lead-service";

/* ---------------------------------------------------------------------------
 * A verifying call's readiness answer asks the stage engine for a move, and the
 * engine's own rules decide. Run against the real database.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
let owner: typeof users.$inferSelect;
let mgr: typeof users.$inferSelect;
let productId: string;

const HAT = { app: "crm", role: "manager" } as const;
const actor = (): LeadMoveActor => ({ userId: mgr.id, hat: HAT, sourceApp: "crm" });
const moveBy = (customerId: string, choice: "trial" | "rates" | "order" | null, over: { canOverride?: boolean } = {}) => {
  const canOverride = over.canOverride ?? true;
  return moveOnReadiness({
    customerId,
    choice,
    actor: canOverride ? actor() : { userId: owner.id, hat: { app: "crm", role: "associate" }, sourceApp: "crm" },
    canOverride,
    overrideHat: canOverride ? HAT : null,
  });
};

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

/** A verified Prospect that has just had Qualification opened — where a verifying call leaves it. */
const lead = async (over: Partial<typeof customers.$inferInsert> = {}) =>
  (
    await db
      .insert(customers)
      .values({
        id: id("cus"),
        name: `Lead ${randomUUID().slice(0, 6)}`,
        contactPerson: "Ganesh",
        phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
        city: "Nashik",
        kind: "lead",
        leadStage: "qualification",
        leadSalesType: "direct",
        leadSource: "manual",
        customerType: "retailer",
        ownerId: owner.id,
        leadManagerId: mgr.id,
        salesManagerId: mgr.id,
        leadMonthlyVolumeLitres: 300,
        leadEstimatedPotentialPaise: 9_000_000,
        leadCompetitor: "Local thinner",
        leadRequiredProductId: productId,
        leadDecisionMaker: "Owner",
        gstin: "27ABCDE1234F1Z5",
        leadApplication: "Wood polish",
        leadCreditDaysWanted: 30,
        leadVerifiedAt: new Date(),
        leadVerifiedById: mgr.id,
        ...over,
      })
      .returning()
  )[0];

/** Both approvals a trial needs, genuinely given: GST validated, Qualification review approved. */
const approvals = (): Partial<typeof customers.$inferInsert> => ({
  gstVerified: true,
  gstVerifiedAt: new Date(),
  gstVerifiedById: mgr.id,
  leadQualificationReview: "verified",
});

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const transitions = (leadId: string) =>
  db.select().from(leadStageTransitions).where(eq(leadStageTransitions.customerId, leadId));
const auditRows = (leadId: string, action: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.entityId, leadId), eq(auditLog.action, action)));
const setSetting = async (key: string, value: unknown, type: string) => {
  await db.execute(sql`
    insert into app_settings (key, value, value_type, category, label)
    values (${key}, ${JSON.stringify(value)}::jsonb, ${type}, 'mbos-leads', 'test')
    on conflict (key) do update set value = excluded.value
  `);
  invalidateConfig();
};

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against a mahekone_test database.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_stage_transitions, mbos_lead_validations, mbos_samples, mbos_tasks, notifications,
      timeline_events, audit_log, orders, app_module_access, app_access, customers, products, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  owner = await makeUser("Tara Telecaller", "associate");
  mgr = await makeUser("Manoj Manager", "manager");
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
});

after(async () => {
  await db.$client.end();
});

describe("each readiness choice goes where the rule says, through the engine", () => {
  test("ready for a trial (both approvals given) → Sample / Trial, the other skipped conditions recorded", async () => {
    const l = await lead(approvals());
    const r = await moveBy(l.id, "trial");
    assert.equal(r.kind, "moved", JSON.stringify(r));
    assert.equal((await row(l.id)).leadStage, "sample_trial");
    const [t] = await transitions(l.id);
    assert.equal(t.toStage, "sample_trial");
    assert.equal(t.reasonCode, "readiness_trial");
    assert.ok(t.overriddenConditions && t.overriddenConditions.length > 0, "what was passed must be recorded");
    assert.ok(!t.overriddenConditions.includes("gst_verified"), "GST validation is never passed by override");
    assert.ok(!t.overriddenConditions.includes("manager_review_pending"), "the manager review is never passed by override");
    assert.equal(t.actorApp, "crm");
    assert.equal(t.actorRole, "manager");
  });

  test("ready for rates and terms → Negotiation, with the explicit 'sample not needed' reason", async () => {
    const l = await lead();
    const r = await moveBy(l.id, "rates");
    assert.equal(r.kind, "moved", JSON.stringify(r));
    assert.equal((await row(l.id)).leadStage, "negotiation");
    const [t] = await transitions(l.id);
    assert.equal(t.reasonCode, "readiness_sample_not_needed");
    assert.match(t.note ?? "", /Sample not needed — customer ready for rates and terms/);
    /* With no sample at all the engine names "no sample has been sent" as the
       condition; review and approval only apply once one exists. Whatever it
       names is what the transition stores, and the sample is not invented. */
    assert.ok(t.overriddenConditions?.includes("sample_sent"), JSON.stringify(t.overriddenConditions));
    assert.equal((await db.select().from(mbosSamples).where(eq(mbosSamples.customerId, l.id))).length, 0);
  });

  test("ready for an order → Negotiation (never 1st Order), with 'Take the order' owed to the account's owner", async () => {
    const l = await lead();
    const r = await moveBy(l.id, "order");
    assert.equal(r.kind, "moved", JSON.stringify(r));
    const after = await row(l.id);
    assert.equal(after.leadStage, "negotiation");
    assert.notEqual(after.leadStage, "first_order");
    assert.equal(after.leadNextAction, "Take the order");
    assert.equal(after.leadNextActionOwnerId, owner.id);
    assert.match(String(after.leadNextActionDate), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal((await transitions(l.id))[0].reasonCode, "readiness_order");
  });

  test("no choice, no movement", async () => {
    const l = await lead();
    assert.deepEqual(await moveBy(l.id, null), { kind: "none" });
    assert.equal((await row(l.id)).leadStage, "qualification");
    assert.equal((await transitions(l.id)).length, 0);
  });
});

describe("nothing is fabricated", () => {
  test("a move creates no sample, no order and no GST verification", async () => {
    for (const choice of ["trial", "rates", "order"] as const) {
      const l = await lead({ gstin: "27ABCDE1234F1Z5", gstVerified: false });
      await moveBy(l.id, choice);
      assert.equal((await db.select().from(mbosSamples).where(eq(mbosSamples.customerId, l.id))).length, 0, `${choice}: sample`);
      assert.equal((await db.select().from(orders).where(eq(orders.customerId, l.id))).length, 0, `${choice}: order`);
      assert.notEqual((await row(l.id)).gstVerified, true, `${choice}: GST must stay unverified`);
    }
  });
});

describe("a trial's two approvals can never be overridden", () => {
  const cases: [string, Partial<typeof customers.$inferInsert>, RegExp[], RegExp[]][] = [
    ["neither approval given", {}, [/GST number has not been validated/, /not been reviewed and approved/], []],
    ["only GST validated", { gstVerified: true, gstVerifiedAt: new Date(), gstVerifiedById: "" }, [/not been reviewed and approved/], [/GST number has not been validated/]],
    ["only the review approved", { leadQualificationReview: "verified" }, [/GST number has not been validated/], [/not been reviewed and approved/]],
  ];
  for (const [name, over, says, notSays] of cases) {
    test(`${name}: blocked even for a verifier holding lead.override with the setting on`, async () => {
      const fix = { ...over };
      if (fix.gstVerifiedById === "") fix.gstVerifiedById = mgr.id;
      const l = await lead(fix);
      const r = await moveBy(l.id, "trial"); // canOverride true, setting default on
      assert.equal(r.kind, "blocked", JSON.stringify(r));
      if (r.kind === "blocked") {
        assert.equal(r.code, "approval_pending");
        for (const re of says) assert.match(r.message, re);
        for (const re of notSays) assert.doesNotMatch(r.message, re);
        assert.match(r.message, /Next:/);
      }
      const after = await row(l.id);
      assert.equal(after.leadStage, "qualification");
      assert.equal((await transitions(l.id)).length, 0);
      assert.equal(after.gstVerified, fix.gstVerified === true, "GST verification is never touched");
      assert.equal(after.leadQualificationReview ?? null, fix.leadQualificationReview ?? null, "the review is never touched");
      assert.equal((await auditRows(l.id, "lead.readiness_move_blocked")).length, 1);
    });
  }

  test("a review sent back as incomplete is not an approval either", async () => {
    const l = await lead({ ...approvals(), leadQualificationReview: "incomplete" });
    const r = await moveBy(l.id, "trial");
    assert.equal(r.kind, "blocked", JSON.stringify(r));
    assert.equal((await row(l.id)).leadStage, "qualification");
  });

  test("rates and order are unaffected by the two approvals", async () => {
    for (const choice of ["rates", "order"] as const) {
      const l = await lead();
      const r = await moveBy(l.id, choice);
      assert.equal(r.kind, "moved", `${choice}: ${JSON.stringify(r)}`);
      assert.equal((await row(l.id)).leadStage, "negotiation");
    }
  });
});

describe("a closed gate is never passed silently", () => {
  test("without lead.override: the stage does not move, the refusal is said and recorded", async () => {
    const l = await lead(approvals());
    const r = await moveBy(l.id, "trial", { canOverride: false });
    assert.equal(r.kind, "blocked", JSON.stringify(r));
    if (r.kind === "blocked") {
      assert.equal(r.code, "override_not_permitted");
      assert.match(r.message, /permission to pass a closed gate/i);
      assert.match(r.message, /Next:/);
    }
    assert.equal((await row(l.id)).leadStage, "qualification");
    assert.equal((await transitions(l.id)).length, 0);
    assert.equal((await auditRows(l.id, "lead.readiness_move_blocked")).length, 1);
  });

  test("with the override setting switched off: blocked, and the setting is left as found", async () => {
    await setSetting("leads.allowManagerOverride", false, "boolean");
    const l = await lead();
    const r = await moveBy(l.id, "rates");
    assert.equal(r.kind, "blocked", JSON.stringify(r));
    if (r.kind === "blocked") assert.equal(r.code, "override_not_offered");
    assert.equal((await row(l.id)).leadStage, "qualification");
    const [setting] = await db.execute<{ value: unknown }>(sql`select value from app_settings where key = 'leads.allowManagerOverride'`);
    assert.equal(setting.value, false, "the global setting must never be changed by a move");
    assert.equal((await auditRows(l.id, "lead.readiness_move_blocked")).length, 1);
  });

  test("a deployment whose stored reason list lacks the readiness codes still records them", async () => {
    await setSetting("leads.overrideReasons", [{ code: "other", label: "Other" }], "structured");
    const l = await lead(approvals());
    const r = await moveBy(l.id, "trial");
    assert.equal(r.kind, "moved", JSON.stringify(r));
    assert.equal((await transitions(l.id))[0].reasonCode, "readiness_trial");
  });
});

describe("a lead that is already there, or further on", () => {
  test("already past the target: nothing moves and nothing is written", async () => {
    const l = await lead({ leadStage: "first_order" });
    const r = await moveBy(l.id, "trial");
    assert.equal(r.kind, "already");
    assert.equal((await row(l.id)).leadStage, "first_order");
    assert.equal((await transitions(l.id)).length, 0);
  });

  test("already in Negotiation and ready for an order: the job is set, the stage is not touched", async () => {
    const l = await lead({ leadStage: "negotiation" });
    const r = await moveBy(l.id, "order");
    assert.equal(r.kind, "already");
    const after = await row(l.id);
    assert.equal(after.leadStage, "negotiation");
    assert.equal(after.leadNextAction, "Take the order");
    assert.equal(after.leadNextActionOwnerId, owner.id);
    assert.equal((await transitions(l.id)).length, 0);
    assert.equal((await auditRows(l.id, "lead.readiness_next_action")).length, 1);
  });
});
