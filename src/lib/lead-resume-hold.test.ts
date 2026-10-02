/**
 * RESUMING A PARKED LEAD.
 *
 * `on_hold` is on no ladder, so the move engine answered `off_ladder` for every
 * move OUT of it and refused with "Qualification is not a rung on this lead's
 * ladder". The park remembers the rung it came from (the newest transition into
 * `on_hold`); a resume is now judged from that rung, and every ordinary rule
 * still applies to the target.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, leadStageTransitions, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { advanceLeadStage } from "@/lib/actions/leads";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { OVERRIDE_REASONS } from "@/lib/lead-labels";
import type { MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const LATER = "2026-12-01";
const AFTER = "2026-12-05";

let associate: typeof users.$inferSelect;
let manager: typeof users.$inferSelect;

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

async function makeLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      contactPerson: "Contact",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nagpur",
      kind: "lead",
      leadStage: "qualification",
      leadSalesType: "direct",
      leadSource: "manual",
      ownerId: associate.id,
      leadManagerId: manager.id,
      /* A lead standing at Qualification got there through the manager's
         verification, which is what that rung's gate re-asks on the way back. */
      leadVerifiedAt: new Date(),
      leadVerifiedById: manager.id,
      ...over,
    })
    .returning();
  return row;
}

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const transitionsOf = (leadId: string) =>
  db
    .select()
    .from(leadStageTransitions)
    .where(eq(leadStageTransitions.customerId, leadId))
    .orderBy(leadStageTransitions.at, leadStageTransitions.id);

/** The park exactly as the record's own control writes it: reason code, resume day, and what happens then. */
async function park(leadId: string) {
  const r = await advanceLeadStage({
    customerId: leadId,
    to: "on_hold",
    reasonCode: "shutdown",
    hold: { reason: "Plant shut for the quarter", resumeDate: LATER },
    nextAction: { action: "Ring the buyer", date: LATER, ownerId: associate.id },
  });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
}

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_stage_transitions, mbos_tasks, notifications, timeline_events, audit_log, app_module_access,
      app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  associate = await makeUser("Desk Caller", "associate");
  manager = await makeUser("Sales Manager", "manager");
  setTestUser(associate);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("resuming a parked lead", () => {
  test("it goes back to the rung it was parked from, and the park is cleared", async () => {
    const lead = await makeLead({ leadStage: "qualification" });
    await park(lead.id);
    assert.equal((await row(lead.id)).leadStage, "on_hold");

    // This is the call that used to answer "Qualification is not a rung on this lead's ladder."
    const r = await advanceLeadStage({ customerId: lead.id, to: "qualification" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const after = await row(lead.id);
    assert.equal(after.leadStage, "qualification");
    assert.equal(after.leadHoldReason, null, "the park's reason goes with the park");
    assert.equal(after.leadHoldReasonCode, null);
    assert.equal(after.leadHoldResumeDate, null, "or it would sit on the resume worklist for ever");
    assert.equal(after.kind, "lead");

    const ts = await transitionsOf(lead.id);
    const parked = ts.find((t) => t.toStage === "on_hold");
    const resumed = ts.find((t) => t.fromStage === "on_hold");
    assert.equal(parked?.fromStage, "qualification", "the park kept its own history");
    assert.equal(resumed?.toStage, "qualification");
    assert.equal(resumed?.kind, "passed");
  });

  test("the lead is not left owing nothing: the park's own next action carries over", async () => {
    const lead = await makeLead();
    await park(lead.id);
    assert.equal((await advanceLeadStage({ customerId: lead.id, to: "qualification" })).ok, true);
    const after = await row(lead.id);
    assert.equal(after.leadNextAction, "Ring the buyer", "what happens when it comes back is still owed");
    assert.equal(after.leadNextActionDate, LATER);
    assert.equal(after.leadNextActionOwnerId, associate.id);
  });

  test("a new next action supplied with the resume replaces it", async () => {
    const lead = await makeLead();
    await park(lead.id);
    const r = await advanceLeadStage({
      customerId: lead.id,
      to: "qualification",
      nextAction: { action: "Visit with the sample", date: AFTER, ownerId: associate.id },
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadNextAction, "Visit with the sample");
    assert.equal(after.leadNextActionDate, AFTER);
  });

  test("a park with no next action on record still has to name one on the way out (§24 applies)", async () => {
    const lead = await makeLead();
    await park(lead.id);
    // A park written by an older handset: no next action survives.
    await db
      .update(customers)
      .set({ leadNextAction: null, leadNextActionDate: null, leadNextActionOwnerId: null })
      .where(eq(customers.id, lead.id));

    const refused = await advanceLeadStage({ customerId: lead.id, to: "qualification" });
    assert.equal(refused.ok, false);
    assert.equal((await row(lead.id)).leadStage, "on_hold", "a refusal writes nothing");

    const ok = await advanceLeadStage({
      customerId: lead.id,
      to: "qualification",
      nextAction: { action: "Ring", date: AFTER, ownerId: associate.id },
    });
    assert.equal(ok.ok, true, ok.ok ? "" : ok.error);
  });

  test("the target's own gate is still asked — resuming does not open a shut rung", async () => {
    // Parked at Negotiation with no sample on record: that rung's conditions are unmet.
    const lead = await makeLead({ leadStage: "negotiation" });
    await park(lead.id);
    const r = await advanceLeadStage({ customerId: lead.id, to: "negotiation" });
    assert.equal(r.ok, false, "the gate for Negotiation is not met, so it is not resumed into it");
    assert.equal((await row(lead.id)).leadStage, "on_hold");
    assert.ok(r.ok === false && (r.fieldErrors?.length ?? 0) > 0, "and it says what is missing");
  });

  test("a manager may pass that shut gate with a reason, exactly as for any other move", async () => {
    const lead = await makeLead({ leadStage: "negotiation" });
    await park(lead.id);
    setTestUser(manager);
    const r = await advanceLeadStage({
      customerId: lead.id,
      to: "negotiation",
      override: { reasonCode: OVERRIDE_REASONS[0]!.code },
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const resumed = (await transitionsOf(lead.id)).find((t) => t.fromStage === "on_hold");
    assert.equal(resumed?.kind, "overridden", "and the override is recorded as one");
  });

  test("coming back BELOW the parked rung is a step backwards: a manager's, with a reason", async () => {
    const lead = await makeLead({ leadStage: "qualification" });
    await park(lead.id);

    const byAssociate = await advanceLeadStage({ customerId: lead.id, to: "prospect" });
    assert.equal(byAssociate.ok, false);
    assert.equal((await row(lead.id)).leadStage, "on_hold");

    setTestUser(manager);
    const noReason = await advanceLeadStage({ customerId: lead.id, to: "prospect" });
    assert.equal(noReason.ok, false, "a step backwards nobody explained teaches nothing");

    const byManager = await advanceLeadStage({
      customerId: lead.id,
      to: "prospect",
      reasonCode: OVERRIDE_REASONS[0]!.code,
      nextAction: { action: "Verify again", date: AFTER, ownerId: manager.id },
    });
    assert.equal(byManager.ok, true, byManager.ok ? "" : byManager.error);
    const resumed = (await transitionsOf(lead.id)).find((t) => t.fromStage === "on_hold");
    assert.equal(resumed?.kind, "reverted");
  });

  test("a rung that is not on the lead's CURRENT ladder is still refused", async () => {
    const lead = await makeLead({ leadStage: "sample_trial" });
    await park(lead.id);
    // The sales type changed while it was parked: Sample / Trial is not a distributor rung.
    await db.update(customers).set({ leadSalesType: "distributor" }).where(eq(customers.id, lead.id));
    const r = await advanceLeadStage({ customerId: lead.id, to: "sample_trial" });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadStage, "on_hold");
  });

  test("parked more than once, it resumes to the rung of the LATEST park", async () => {
    const lead = await makeLead({ leadStage: "suspect" });
    await park(lead.id);
    assert.equal((await advanceLeadStage({ customerId: lead.id, to: "suspect" })).ok, true);
    await db.update(customers).set({ leadStage: "qualification" }).where(eq(customers.id, lead.id));
    await park(lead.id);
    const r = await advanceLeadStage({ customerId: lead.id, to: "qualification" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadStage, "qualification");
  });

  test("a parked lead can still be closed Lost", async () => {
    const lead = await makeLead();
    await park(lead.id);
    const lost = await advanceLeadStage({ customerId: lead.id, to: "lost", reasonCode: "price" });
    assert.equal(lost.ok, true, lost.ok ? "" : lost.error);
    assert.equal((await row(lead.id)).leadStage, "lost");
  });
});

describe("resuming from the handset goes through the same rule", () => {
  test("a stage change to the parked rung is accepted instead of refused as off-ladder", async () => {
    const [field] = await db
      .insert(users)
      .values({
        id: id("usr"),
        name: "Field Man",
        email: `field-${randomUUID().slice(0, 4)}@test.local`,
        phone: String(9820000000 + Math.floor(Math.random() * 999999)),
        passwordHash: "x",
        role: "associate",
        initials: "FM",
      })
      .returning();
    await db.insert(appAccess).values({ id: id("aca"), userId: field.id, app: "field" });
    await db.insert(appAccess).values({ id: id("aca"), userId: field.id, app: "crm", role: "associate" });
    const principal = {
      user: field,
      deviceId: "probe-device",
      role: "associate",
      scope: { kind: "own", userIds: [field.id] },
    } as MbosPrincipal;

    const lead = await makeLead({ leadStage: "qualification", ownerId: field.id });
    setTestUser(field);
    const parked = await advanceLeadStage({
      customerId: lead.id,
      to: "on_hold",
      reasonCode: "shutdown",
      hold: { reason: "Shut", resumeDate: LATER },
      nextAction: { action: "Ring", date: LATER, ownerId: field.id },
    });
    assert.equal(parked.ok, true, parked.ok ? "" : parked.error);

    const item: SyncItem = {
      queueId: id("q"),
      entityType: "lead",
      entityId: lead.id,
      op: "update",
      idempotencyKey: `${lead.id}:update:${randomUUID()}`,
      clientCreatedAt: Date.now(),
      payload: { stage: "qualification" },
    };
    const [result] = await ingestSyncBatch(principal, [item]);
    assert.equal(result.status, "accepted", JSON.stringify(result));
    assert.equal((await row(lead.id)).leadStage, "qualification");
  });
});
