/**
 * Reversing a Lost lead — the Sales Manager's door and the Telecaller's, over
 * the ONE shared implementation (`reopenLostLead`).
 *
 *   A  Shared: same row, history kept, reason, next action, archive, idempotence
 *   B  Sales Manager: the rung restored, a failed verification asked again, scope
 *   C  Telecaller: a lead lost at Call 3 is genuinely callable again, calls kept
 *   D  The ladder still applies: a reopened lead cannot skip to Customer
 *   E  Read-only users, and the Lost list's own data
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
  calls,
  customers,
  leadStageTransitions,
  orders,
  products,
  timelineEvents,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { advanceLeadStage } from "@/lib/actions/leads";
import {
  convertLeadToProspect,
  logQualificationCall,
  reopenDeskLead,
} from "@/lib/actions/lead-calling-desk";
import { reopenSalesManagerLead } from "@/lib/actions/lead-reopen";
import { callingDesk, deskLeadRecord } from "@/lib/services/lead-calling-desk-service";
import { lostLeadsPage } from "@/lib/services/lead-lost-service";
import { VERIFICATION_FAILED_CODE } from "@/lib/lead-labels";
import { buildPull, type MbosPrincipal } from "@/lib/services/mbos-service";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const DAY = "2026-10-01";
const LATER = "2026-12-01";

let desk: typeof users.$inferSelect;
let other: typeof users.$inferSelect;
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

async function makeLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
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
      leadSource: "Website / Online Enquiry",
      ownerId: desk.id,
      leadManagerId: manager.id,
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

/** Closes a lead as lost through the one door every loss goes through. */
async function loseAs(user: typeof users.$inferSelect, leadId: string, reasonCode = "price") {
  setTestUser(user);
  const r = await advanceLeadStage({ customerId: leadId, to: "lost", reasonCode });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
}

const reverse = (leadId: string, over: Partial<Parameters<typeof reopenSalesManagerLead>[0]> = {}) =>
  reopenSalesManagerLead({ customerId: leadId, reasonCode: "customer_responded", ...over });

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_stage_transitions, lead_verification_corrections, mbos_lead_validations, mbos_tasks,
      calls, orders, notifications, timeline_events, audit_log, app_module_access, app_access, customers, products,
      users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  desk = await makeUser("Desk Caller", "associate");
  other = await makeUser("Other Caller", "associate");
  manager = await makeUser("Sales Manager", "manager");
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
  setTestUser(manager);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("A — what every reversal does, whichever door", () => {
  test("the same row comes back, the loss stays, and a reopen transition is appended", async () => {
    const lead = await makeLead({ leadStage: "qualification" });
    const before = (await db.select({ n: sql<number>`count(*)::int` }).from(customers))[0].n;
    await loseAs(manager, lead.id, "price");

    const r = await reverse(lead.id, { note: "Rang us on Monday" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const after = await row(lead.id);
    assert.equal(after.leadStage, "qualification", "restored to the rung it was lost from");
    assert.equal(after.leadLostReason, null, "the CURRENT lost reason is cleared");
    assert.equal((await db.select({ n: sql<number>`count(*)::int` }).from(customers))[0].n, before, "no second lead");

    const ts = await transitionsOf(lead.id);
    const loss = ts.find((t) => t.toStage === "lost");
    const reopen = ts.find((t) => t.fromStage === "lost");
    assert.ok(loss && reopen, "both the loss and the reopen are on the record");
    assert.equal(loss.fromStage, "qualification");
    assert.equal(loss.reasonCode, "price", "the historical lost reason is preserved on the transition");
    assert.equal(reopen.toStage, "qualification");
    assert.equal(reopen.reasonCode, "customer_responded");
    assert.match(reopen.note ?? "", /^Reopened from Lost/);
    assert.match(reopen.note ?? "", /Rang us on Monday/);
    assert.match(reopen.note ?? "", /Previously lost: Price/);
    assert.notEqual(reopen.kind, "reverted", "not the generic walk-down, which belongs to lead.override");
  });

  test("it is audited and lands on the timeline, and nothing earlier is touched", async () => {
    const lead = await makeLead({ leadStage: "qualification" });
    await loseAs(manager, lead.id);
    const auditBefore = (await db.select().from(auditLog).where(eq(auditLog.entityId, lead.id))).length;
    const lossRow = (await transitionsOf(lead.id)).find((t) => t.toStage === "lost")!;

    assert.equal((await reverse(lead.id)).ok, true);

    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, lead.id));
    assert.equal(audits.length, auditBefore + 1, "one new audit row, none rewritten");
    assert.ok(audits.some((a) => a.action === "lead.stage.reopen"));
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.customerId, lead.id));
    assert.ok(events.some((e) => /reopened from Lost/i.test(e.summary)));
    const after = (await transitionsOf(lead.id)).find((t) => t.id === lossRow.id)!;
    assert.deepEqual(
      { ...after, at: after.at.getTime() },
      { ...lossRow, at: lossRow.at.getTime() },
      "the original lost transition is unchanged",
    );
  });

  test("a reopened lead owes somebody something: the next action, its day and its owner", async () => {
    const lead = await makeLead({ leadStage: "qualification" });
    await loseAs(manager, lead.id);
    assert.equal((await reverse(lead.id, { nextAction: { action: "Ring the buyer", date: LATER } })).ok, true);
    const after = await row(lead.id);
    assert.equal(after.leadNextAction, "Ring the buyer");
    assert.equal(after.leadNextActionDate, LATER);
    assert.ok(after.leadNextActionOwnerId, "somebody owns it");
  });

  test("a reason is demanded, and must be a configured one; Other demands a note", async () => {
    const lead = await makeLead({ leadStage: "qualification" });
    await loseAs(manager, lead.id);

    const unknown = await reverse(lead.id, { reasonCode: "because" });
    assert.equal(unknown.ok, false);
    const noNote = await reverse(lead.id, { reasonCode: "other" });
    assert.equal(noNote.ok, false);
    assert.match(!noNote.ok ? noNote.error : "", /say in words/i);
    assert.equal((await row(lead.id)).leadStage, "lost", "a refusal writes nothing");
    assert.equal((await transitionsOf(lead.id)).filter((t) => t.fromStage === "lost").length, 0);

    const fine = await reverse(lead.id, { reasonCode: "other", note: "Their son took over" });
    assert.equal(fine.ok, true, fine.ok ? "" : fine.error);
  });

  test("an archived lost lead comes back out of the archive, and the history says so", async () => {
    const lead = await makeLead({ leadStage: "qualification", leadArchived: true, leadArchivedAt: new Date() });
    await loseAs(manager, lead.id);
    assert.equal((await row(lead.id)).leadArchived, true);

    assert.equal((await reverse(lead.id)).ok, true);
    const after = await row(lead.id);
    assert.equal(after.leadArchived, false);
    assert.equal(after.leadArchivedAt, null);
    const reopen = (await transitionsOf(lead.id)).find((t) => t.fromStage === "lost")!;
    assert.match(reopen.note ?? "", /archive/i);
  });

  test("two simultaneous reversals make one reopen, and the loser is refused cleanly", async () => {
    const lead = await makeLead({ leadStage: "qualification" });
    await loseAs(manager, lead.id);

    const [a, b] = await Promise.all([reverse(lead.id), reverse(lead.id)]);
    assert.equal([a, b].filter((r) => r.ok).length, 1, "exactly one succeeded");
    const loser = [a, b].find((r) => !r.ok)!;
    assert.equal(!loser.ok && loser.code, "conflict");
    assert.equal(
      (await transitionsOf(lead.id)).filter((t) => t.fromStage === "lost").length,
      1,
      "never two reopen transitions from one loss",
    );

    const again = await reverse(lead.id);
    assert.equal(again.ok, false, "a lead that is not Lost has nothing to reverse");
  });

  test("a lead lost, reopened and lost again restores from the LATEST loss", async () => {
    const lead = await makeLead({ leadStage: "prospect", leadSalesType: "direct" });
    await loseAs(manager, lead.id);
    assert.equal((await reverse(lead.id)).ok, true);
    assert.equal((await row(lead.id)).leadStage, "prospect");
    await db.update(customers).set({ leadStage: "qualification" }).where(eq(customers.id, lead.id));
    await loseAs(manager, lead.id, "competitor");
    assert.equal((await reverse(lead.id)).ok, true);
    assert.equal((await row(lead.id)).leadStage, "qualification");
  });
});

describe("B — the Sales Manager", () => {
  test("a lead lost at Qualification returns to Qualification and the pipeline carries on", async () => {
    const lead = await makeLead({ leadStage: "qualification" });
    await loseAs(manager, lead.id);
    assert.equal((await reverse(lead.id)).ok, true);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "qualification");
    assert.equal(after.kind, "lead", "still a lead — reopening promotes nothing");
  });

  test("a rung the ladder no longer has starts again at the foot, never in an invalid state", async () => {
    const lead = await makeLead({ leadStage: "sample_trial" });
    await loseAs(manager, lead.id);
    // The sales type changes while it is lost: Sample / Trial is not a rung of the distributor ladder.
    await db.update(customers).set({ leadSalesType: "distributor" }).where(eq(customers.id, lead.id));
    assert.equal((await reverse(lead.id)).ok, true);
    assert.equal((await row(lead.id)).leadStage, "suspect");
  });

  test("a failed verification is asked again, not assumed", async () => {
    const lead = await makeLead({
      leadStage: "prospect",
      leadVerifiedAt: new Date(),
      leadVerifiedById: manager.id,
      leadQualificationReview: "verified",
    });
    await loseAs(manager, lead.id, VERIFICATION_FAILED_CODE);

    assert.equal((await reverse(lead.id)).ok, true);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect", "back where verification lives");
    assert.equal(after.leadVerifiedAt, null, "NOT treated as already verified");
    assert.equal(after.leadVerifiedById, null);
    assert.equal(after.leadQualificationReview, null);
    assert.match(after.leadNextAction ?? "", /verification/i, "the next action is the verification call");
  });

  test("an associate who can read the Lost list cannot reverse from it", async () => {
    const lead = await makeLead({ leadStage: "qualification" });
    await loseAs(manager, lead.id);
    setTestUser(desk);
    const r = await reverse(lead.id);
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadStage, "lost");
  });

  test("a manager with no seat on the lead and no sight of its owner cannot reverse it", async () => {
    const outsider = await makeUser("Other Manager", "manager");
    const lead = await makeLead({ leadStage: "qualification", ownerId: other.id, leadManagerId: null });
    await db.update(customers).set({ leadStage: "lost", leadLostReason: "price" }).where(eq(customers.id, lead.id));
    setTestUser(outsider);
    const r = await reverse(lead.id);
    // A manager sees their reports' books; this lead belongs to nobody they manage.
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadStage, "lost");
  });
});

describe("C — the Telecaller", () => {
  const tomorrow = LATER;
  /** A suspect that ran out of calls and was closed Lost by the desk's own rule. */
  async function lostAtCallThree() {
    const lead = await makeLead();
    setTestUser(desk);
    const one = await logQualificationCall({
      customerId: lead.id,
      outcome: "spoke_callback",
      answers: { monthlyLitres: 200 },
      next: { kind: "call", text: "x", date: tomorrow },
    });
    assert.equal(one.ok, true, one.ok ? "" : one.error);
    await logQualificationCall({
      customerId: lead.id,
      outcome: "spoke_callback",
      answers: { requiredProductId: productId },
      next: { kind: "call", text: "x", date: tomorrow },
    });
    const three = await logQualificationCall({ customerId: lead.id, outcome: "spoke_callback", answers: {} });
    assert.equal(three.ok && three.data.result, "lost", "the compulsory competitor was never learned");
    assert.equal((await row(lead.id)).leadStage, "lost");
    return lead;
  }

  test("a lead lost at Call 3 is callable again, and not one call is deleted", async () => {
    const lead = await lostAtCallThree();
    const callsBefore = await db.select().from(calls).where(eq(calls.customerId, lead.id));
    assert.equal(callsBefore.length, 3);

    const r = await reopenDeskLead({ customerId: lead.id, reasonCode: "customer_responded" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    assert.equal((await row(lead.id)).leadStage, "suspect");
    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.phase, "call1", "NOT exhausted — a genuinely workable lead");
    assert.equal(rec?.callCount, 0, "this round has no calls yet");
    assert.equal(rec?.calls.length, 3, "the earlier calls are all still on the record");
    assert.ok(rec?.calls.every((c) => c.earlier));
    assert.equal(rec?.lost, null, "the Lost banner is gone");
    assert.ok(rec?.reopened, "and it says it was reopened");

    const callsAfter = await db.select().from(calls).where(eq(calls.customerId, lead.id));
    assert.deepEqual(
      callsAfter.map((c) => c.id).sort(),
      callsBefore.map((c) => c.id).sort(),
      "no call record was deleted or added by the reopen",
    );

    const listed = (await callingDesk(DAY, "all")).all.find((l) => l.id === lead.id);
    assert.equal(listed?.phase, "call1", "it shows on the desk as a lead to ring");
  });

  test("the first call after a reopen is Call 1 again, and the three-call rule applies afresh", async () => {
    const lead = await lostAtCallThree();
    assert.equal((await reopenDeskLead({ customerId: lead.id, reasonCode: "followup_requested" })).ok, true);

    const c1 = await logQualificationCall({
      customerId: lead.id,
      outcome: "spoke_callback",
      answers: { decisionMaker: "Owner" },
      next: { kind: "call", text: "x", date: tomorrow },
    });
    assert.equal(c1.ok && c1.data.callNumber, 1, c1.ok ? "" : c1.error);
    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.callCount, 1);
    assert.equal(rec?.phase, "call2");
    assert.equal(rec?.calls.length, 4, "all four calls are in the history");

    // A second full round closes it again, and again it can come back.
    await logQualificationCall({ customerId: lead.id, outcome: "spoke_callback", answers: {}, next: { kind: "call", text: "x", date: tomorrow } });
    const last = await logQualificationCall({ customerId: lead.id, outcome: "spoke_callback", answers: {} });
    assert.equal(last.ok && last.data.result, "lost");
    assert.equal((await reopenDeskLead({ customerId: lead.id, reasonCode: "followup_requested" })).ok, true);
    assert.equal((await deskLeadRecord(lead.id, DAY))?.phase, "call1");
  });

  test("the desk workflow carries on: a reopened lead can be completed and requested as a Prospect", async () => {
    const lead = await lostAtCallThree();
    assert.equal((await reopenDeskLead({ customerId: lead.id, reasonCode: "ready_to_purchase" })).ok, true);
    const done = await logQualificationCall({
      customerId: lead.id,
      outcome: "spoke_collected",
      answers: {
        competitor: "Local thinner",
        decisionMaker: "Owner himself",
      },
    });
    assert.equal(done.ok && done.data.result, "ready", done.ok ? "" : done.error);
    const converted = await convertLeadToProspect({
      customerId: lead.id,
      reasonCode: "regular_requirement",
      customerType: "manufacturer",
      note: "Back after a loss.",
    });
    assert.equal(converted.ok, true, converted.ok ? "" : converted.error);
    assert.equal((await row(lead.id)).leadStage, "prospect");
  });

  test("the desk grant and the lead's scope are both still enforced", async () => {
    const lead = await lostAtCallThree();

    setTestUser(other);
    const outside = await reopenDeskLead({ customerId: lead.id, reasonCode: "customer_responded" });
    assert.equal(outside.ok, false, "another telecaller's lead is not theirs to reopen");

    setTestUser(desk);
    await db.insert(appModuleAccess).values({ id: id("mod"), userId: desk.id, app: "crm", module: "crm.leads" });
    const noDesk = await reopenDeskLead({ customerId: lead.id, reasonCode: "customer_responded" });
    assert.equal(noDesk.ok, false, "without the Calling desk it is refused at the door");
    assert.match(!noDesk.ok ? noDesk.error : "", /Calling desk/);
    assert.equal((await row(lead.id)).leadStage, "lost");
  });

  test("a loss the Sales Manager closed on a failed verification is theirs to reverse, not the desk's", async () => {
    const lead = await makeLead({ leadStage: "prospect" });
    await loseAs(manager, lead.id, VERIFICATION_FAILED_CODE);
    setTestUser(desk);
    const r = await reopenDeskLead({ customerId: lead.id, reasonCode: "customer_responded" });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /Sales Manager/);
    assert.equal((await row(lead.id)).leadStage, "lost");
  });
});

describe("D — a reopened lead still has to earn every rung", () => {
  test("it cannot jump to Customer because it was further along once", async () => {
    const lead = await makeLead({ leadStage: "payment" });
    await loseAs(manager, lead.id);
    assert.equal((await reverse(lead.id)).ok, true);
    assert.equal((await row(lead.id)).leadStage, "payment");

    for (const to of ["second_order", "customer"] as const) {
      const r = await advanceLeadStage({
        customerId: lead.id,
        to,
        nextAction: { action: "Chase", date: LATER, ownerId: manager.id },
      });
      assert.equal(r.ok, false, `${to} is still behind its gate`);
    }
    const after = await row(lead.id);
    assert.equal(after.leadStage, "payment");
    assert.equal(after.kind, "lead", "not promoted");
  });

  test("a lead lost from the promoting rung comes back one below it", async () => {
    const lead = await makeLead({ leadStage: "second_order" });
    await loseAs(manager, lead.id);
    assert.equal((await reverse(lead.id)).ok, true);
    assert.equal((await row(lead.id)).leadStage, "payment");
  });

  test("once the real conditions are met it converts to a Customer in the ordinary way", async () => {
    const lead = await makeLead({ leadStage: "payment" });
    await loseAs(manager, lead.id);
    assert.equal((await reverse(lead.id)).ok, true);

    for (let i = 0; i < 2; i++) {
      await db.insert(orders).values({
        id: id("ord"),
        customerId: lead.id,
        userId: desk.id,
        orderedAt: new Date(),
        totalAmount: 5_000_00,
        status: "dispatched",
      });
    }
    const r = await advanceLeadStage({
      customerId: lead.id,
      to: "second_order",
      nextAction: { action: "Look after the account", date: LATER, ownerId: manager.id },
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal(r.ok && r.data.promoted, true);
    assert.equal((await row(lead.id)).kind, "customer");
  });
});

describe("F — the handset", () => {
  test("a lead reopened in the office reaches the phone as an ordinary change, at its restored rung", async () => {
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
    const principal = {
      user: field,
      deviceId: "probe-device",
      role: "associate",
      scope: { kind: "own", userIds: [field.id] },
    } as MbosPrincipal;

    const lead = await makeLead({ leadStage: "qualification", ownerId: field.id, leadManagerId: manager.id });
    await loseAs(manager, lead.id);

    // Lost leads are not on the handset's lead channel, so nothing of it is sent.
    const whileLost = await buildPull(principal, null);
    assert.ok(!(whileLost.leads as { id: string }[]).some((l) => l.id === lead.id));

    const cursor = (await buildPull(principal, null)).cursor;
    await new Promise((r) => setTimeout(r, 15));
    setTestUser(manager);
    assert.equal((await reverse(lead.id)).ok, true);

    const delta = await buildPull(principal, cursor);
    const sent = (delta.leads as { id: string; stage: string }[]).find((l) => l.id === lead.id);
    assert.ok(sent, "the reopened lead moved updated_at, so the next pull carries it");
    assert.equal(sent.stage, "qualification", "and it carries the restored rung, not `lost`");
  });
});

describe("G — a loss queued on a phone BEFORE the office reopened the lead", () => {
  async function fieldMan() {
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
    return { field, principal };
  }

  const lossItem = (leadId: string, clientCreatedAt: number): SyncItem => ({
    queueId: id("q"),
    entityType: "lead",
    entityId: leadId,
    op: "update",
    idempotencyKey: `${leadId}:update:${randomUUID()}`,
    clientCreatedAt,
    payload: { stage: "lost", reasonCode: "price" },
  });

  test("the stale loss does not undo the reopen — it is refused in words, with the lead left open", async () => {
    const { field, principal } = await fieldMan();
    const lead = await makeLead({ leadStage: "qualification", ownerId: field.id, leadManagerId: manager.id });

    // The salesman pressed "Lost" with no signal, and the item sits in his outbox.
    const decidedOnThePhone = Date.now() - 60_000;
    // Meanwhile the office closed it and then reversed it.
    await loseAs(manager, lead.id, "competitor");
    setTestUser(manager);
    assert.equal((await reverse(lead.id)).ok, true);
    assert.equal((await row(lead.id)).leadStage, "qualification");

    // The phone finds a bar and the outbox drains.
    const [result] = await ingestSyncBatch(principal, [lossItem(lead.id, decidedOnThePhone)]);
    assert.equal(result.status, "rejected", JSON.stringify(result));
    assert.match(JSON.stringify(result), /before the office reopened it/);

    const after = await row(lead.id);
    assert.equal(after.leadStage, "qualification", "the office's reopen stands");
    assert.equal(after.leadLostReason, null);
    assert.equal(
      (await transitionsOf(lead.id)).filter((t) => t.toStage === "lost").length,
      1,
      "no second loss was written",
    );
  });

  test("a loss decided AFTER the reopen is a legitimate newer write and still lands", async () => {
    const { field, principal } = await fieldMan();
    const lead = await makeLead({ leadStage: "qualification", ownerId: field.id, leadManagerId: manager.id });
    await loseAs(manager, lead.id, "competitor");
    setTestUser(manager);
    assert.equal((await reverse(lead.id)).ok, true);

    const [result] = await ingestSyncBatch(principal, [lossItem(lead.id, Date.now() + 5_000)]);
    assert.equal(result.status, "accepted", JSON.stringify(result));
    assert.equal((await row(lead.id)).leadStage, "lost");
  });

  test("a lead that was never reopened is untouched by the rule", async () => {
    const { field, principal } = await fieldMan();
    const lead = await makeLead({ leadStage: "qualification", ownerId: field.id, leadManagerId: manager.id });
    const [result] = await ingestSyncBatch(principal, [lossItem(lead.id, Date.now() - 60_000)]);
    assert.equal(result.status, "accepted", JSON.stringify(result));
    assert.equal((await row(lead.id)).leadStage, "lost");
  });
});

describe("E — the Lost list", () => {
  test("a reopened lead leaves the Lost list, and the same id is the one that comes back", async () => {
    const lead = await makeLead({ leadStage: "qualification" });
    await loseAs(manager, lead.id);
    /* The Lost list is a `managerScope` read, and a test names no app on its
       request — so the reader's level is asked on the Sales Dashboard. A CRM
       manager with no Sales grant is narrowed to their own book there, which
       holds nothing; the manager reading the list holds it as a manager. */
    await db.insert(appAccess).values({ id: id("aca"), userId: manager.id, app: "sales", role: "manager" });
    setTestUser(manager);
    assert.deepEqual((await lostLeadsPage()).rows.map((r) => r.id), [lead.id]);
    assert.equal((await reverse(lead.id)).ok, true);
    assert.deepEqual((await lostLeadsPage()).rows.map((r) => r.id), []);
    const [still] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(leadStageTransitions)
      .where(and(eq(leadStageTransitions.customerId, lead.id), eq(leadStageTransitions.toStage, "lost")));
    assert.equal(still.n, 1, "the loss remains in the history for ever");
  });
});
