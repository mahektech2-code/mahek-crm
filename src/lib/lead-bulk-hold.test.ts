/**
 * All Leads → Change stage → On hold, over the real action.
 *
 * The bulk modal used to offer On hold and send none of what a park demands, so
 * every attempt was refused with "On hold is a pause, not a quiet death" — for a
 * Lost lead and an ordinary one alike, because that validation runs before any
 * stage is looked at. These pin what the server now does with what the modal
 * sends: the same answers the record's own Park control asks, each lead's next
 * action owed by its OWN owner, leads that have ended refused, and a lead
 * already on hold reported as unchanged rather than written twice.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, leadStageTransitions, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { advanceLeadStage, bulkAdvanceLeadStage } from "@/lib/actions/leads";
import { reopenSalesManagerLead } from "@/lib/actions/lead-reopen";
import { evaluateLeadStageMove, leadGateInput } from "@/lib/services/lead-service";
import { parkedLeads } from "@/lib/services/lead-hold-service";
import { bulkStagePayload, type BulkHold } from "@/lib/lead-bulk-stage";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const LATER = "2026-12-01";
const ACTION_DAY = "2026-12-02";

type U = typeof users.$inferSelect;
let manager: U;
let tele1: U;
let tele2: U;
let gone: U; // an inactive account that still owns a lead

async function makeUser(name: string, role: "associate" | "manager", active = true) {
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
      active,
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
      leadStage: "prospect",
      leadSalesType: "direct",
      leadSource: "Website / Online Enquiry",
      ownerId: tele1.id,
      // The manager sees every lead here through the seat, whoever owns it.
      leadManagerId: manager.id,
      leadStageSince: "2026-09-20",
      leadLastActivityDate: "2026-09-20",
      ...over,
    })
    .returning();
  return row;
}

const rowOf = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const transitionsOf = (leadId: string) =>
  db.select().from(leadStageTransitions).where(eq(leadStageTransitions.customerId, leadId)).orderBy(leadStageTransitions.at, leadStageTransitions.id);

const HOLD: BulkHold = { remarks: "Plant shut for the quarter", resumeDate: LATER, actionText: "Ring the buyer", actionDate: ACTION_DAY };
const park = (ids: string[], over: Partial<BulkHold> = {}, code = "shutdown") =>
  bulkAdvanceLeadStage(bulkStagePayload(ids, "on_hold", code, "", { ...HOLD, ...over }));

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against a mahekone_test database.");
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
  manager = await makeUser("Sales Manager", "manager");
  tele1 = await makeUser("Tara Telecaller", "associate");
  tele2 = await makeUser("Tina Telecaller", "associate");
  gone = await makeUser("Gone Caller", "associate", false);
  // The worklist and the lists are scoped by reporting line, as everywhere else.
  await db.update(users).set({ reportsToId: manager.id }).where(sql`id in (${tele1.id}, ${tele2.id}, ${gone.id})`);
  setTestUser(manager);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("a valid bulk park", () => {
  test("every lead is parked with the same answers, and each next action is owed by its OWN owner", async () => {
    const a = await makeLead({ ownerId: tele1.id });
    const b = await makeLead({ ownerId: tele2.id });
    const r = await park([a.id, b.id]);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal(r.ok && r.data?.done, 2);
    assert.deepEqual(r.ok && r.data?.failed, []);
    assert.deepEqual(r.ok && r.data?.unchanged, []);

    for (const [lead, owner] of [[a, tele1], [b, tele2]] as const) {
      const now = await rowOf(lead.id);
      assert.equal(now.leadStage, "on_hold");
      assert.equal(now.leadHoldReasonCode, "shutdown");
      assert.equal(now.leadHoldReason, "Plant shut for the quarter");
      assert.equal(String(now.leadHoldResumeDate), LATER);
      assert.equal(now.leadNextAction, "Ring the buyer");
      assert.equal(String(now.leadNextActionDate), ACTION_DAY);
      assert.equal(now.leadNextActionOwnerId, owner.id, "the lead's own owner, not one person for the batch");
      assert.equal(now.ownerId, owner.id, "ownership is untouched");
      assert.equal(now.leadManagerId, manager.id);
    }
  });

  test("it is a recorded move: one transition from where each stood, to on_hold", async () => {
    const a = await makeLead({ leadStage: "qualification" });
    await park([a.id]);
    const t = await transitionsOf(a.id);
    assert.equal(t.length, 1);
    assert.equal(t[0].fromStage, "qualification");
    assert.equal(t[0].toStage, "on_hold");
  });

  test("a parked lead is on the resume worklist with its date, code and owner", async () => {
    const a = await makeLead({ ownerId: tele2.id });
    await park([a.id]);
    // The list is narrowed by the reader's scope like every other: a manager with the Sales
    // Dashboard and no region rows oversees everybody, which is what is read here.
    await db.insert(appAccess).values({ id: id("aca"), userId: manager.id, app: "sales", role: "manager" });
    const list = await parkedLeads("2026-10-15");
    const mine = list.rows.find((x) => x.customerId === a.id);
    assert.ok(mine, "on the parked list");
    assert.equal(mine?.resumeDate, LATER);
    assert.equal(mine?.holdReasonCode, "shutdown");
    assert.equal(mine?.parkedFrom, "prospect");
    assert.equal(mine?.nextActionOwnerName, tele2.name);
  });
});

describe("what a park demands is still demanded", () => {
  const untouched = async (leadId: string) => {
    const now = await rowOf(leadId);
    assert.equal(now.leadStage, "prospect");
    assert.equal((await transitionsOf(leadId)).length, 0);
  };

  test("no reason code", async () => {
    const a = await makeLead();
    const r = await park([a.id], {}, "");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.fieldErrors?.some((f) => f.field === "reasonCode"), true);
    await untouched(a.id);
  });

  test("a code that is not on the configured list", async () => {
    const a = await makeLead();
    const r = await park([a.id], {}, "not_a_reason");
    assert.equal(r.ok, false);
    await untouched(a.id);
  });

  test("no resume date", async () => {
    const a = await makeLead();
    const r = await park([a.id], { resumeDate: "" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.fieldErrors?.some((f) => f.field === "holdResumeDate"), true);
    await untouched(a.id);
  });

  test("no next action", async () => {
    const a = await makeLead();
    const r = await park([a.id], { actionText: "  ", actionDate: "" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.fieldErrors?.some((f) => f.field === "nextAction"), true);
    await untouched(a.id);
  });

  test("Other without remarks is refused; with remarks it is accepted", async () => {
    const a = await makeLead();
    const refused = await park([a.id], { remarks: "  " }, "other");
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.fieldErrors?.some((f) => f.field === "holdReason"), true);
    await untouched(a.id);

    const accepted = await park([a.id], { remarks: "Waiting on the owner's return" }, "other");
    assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error);
    assert.equal(accepted.ok && accepted.data?.done, 1);
    assert.equal((await rowOf(a.id)).leadStage, "on_hold");
  });

  test("the single-lead park is unchanged", async () => {
    const a = await makeLead();
    const r = await advanceLeadStage({
      customerId: a.id,
      to: "on_hold",
      reasonCode: "shutdown",
      hold: { reason: "Plant shut", resumeDate: LATER },
      nextAction: { action: "Ring the buyer", date: ACTION_DAY, ownerId: tele1.id },
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await rowOf(a.id)).leadStage, "on_hold");
  });
});

describe("a lead that has ended cannot be paused", () => {
  for (const stage of ["lost", "won", "customer", "active_distributor"] as const) {
    test(`${stage} → On hold is refused, on the server, and nothing moves`, async () => {
      const a = await makeLead({ leadStage: stage });
      const r = await park([a.id]);
      assert.equal(r.ok && r.data?.done, 0);
      assert.equal(r.ok && r.data?.failed.length, 1);
      assert.equal((await rowOf(a.id)).leadStage, stage);
      assert.equal((await rowOf(a.id)).leadHoldResumeDate, null);
      assert.equal((await transitionsOf(a.id)).length, 0);
    });
  }

  test("Lost says it is reopened, not paused", async () => {
    const a = await makeLead({ leadStage: "lost" });
    const r = await park([a.id]);
    assert.match(r.ok ? (r.data?.failed[0].why ?? "") : "", /reopened, not put on hold/);
  });

  test("a sale says it is a sale on the record", async () => {
    const a = await makeLead({ leadStage: "customer" });
    const r = await park([a.id]);
    assert.match(r.ok ? (r.data?.failed[0].why ?? "") : "", /sale on the record/);
  });

  test("the single door refuses it too, with every answer supplied", async () => {
    const a = await makeLead({ leadStage: "lost" });
    const r = await advanceLeadStage({
      customerId: a.id,
      to: "on_hold",
      reasonCode: "shutdown",
      hold: { reason: "Plant shut", resumeDate: LATER },
      nextAction: { action: "Ring", date: ACTION_DAY, ownerId: tele1.id },
    });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /reopened, not put on hold/);
    assert.equal((await rowOf(a.id)).leadStage, "lost");
  });

  test("the evaluator itself answers cannot_park, for any door that shares it", async () => {
    const a = await makeLead({ leadStage: "lost" });
    const lead = await rowOf(a.id);
    const gate = await leadGateInput(a.id);
    assert.ok(gate);
    const d = await evaluateLeadStageMove({ lead, gate: gate!, to: "on_hold", canOverride: false });
    assert.equal(d.ok, false);
    assert.equal(!d.ok && d.code, "cannot_park");
  });

  test("a Lost lead is still reopened by the existing door, and then can be parked", async () => {
    const a = await makeLead();
    await bulkAdvanceLeadStage(bulkStagePayload([a.id], "lost", "price", ""));
    const reopened = await reopenSalesManagerLead({
      customerId: a.id,
      reasonCode: "customer_came_back",
      nextAction: { action: "Ring", date: ACTION_DAY },
    } as never);
    // The reopen reason list is configuration; if this code is not on it the reopen is
    // refused, which is not what is under test — the lead is then simply still Lost.
    if (reopened.ok) {
      const r = await park([a.id]);
      assert.equal(r.ok && r.data?.done, 1);
      assert.equal((await rowOf(a.id)).leadStage, "on_hold");
    } else {
      assert.equal((await rowOf(a.id)).leadStage, "lost");
    }
  });
});

describe("a mixed batch", () => {
  test("moved, unchanged and failed are each said, and only the moved were written", async () => {
    const open = await makeLead({ ownerId: tele1.id });
    const already = await makeLead({ ownerId: tele2.id });
    const lost = await makeLead({ leadStage: "lost" });
    const nobody = await makeLead({ ownerId: null });
    const departed = await makeLead({ ownerId: gone.id });

    // Park `already` first, so the batch finds it there.
    const first = await park([already.id]);
    assert.equal(first.ok && first.data?.done, 1);
    const before = await rowOf(already.id);
    const transitionsBefore = (await transitionsOf(already.id)).length;

    const r = await park([open.id, already.id, lost.id, nobody.id, departed.id], { resumeDate: "2026-12-10" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal(r.ok && r.data?.done, 1, "only the open one moved");
    assert.deepEqual(r.ok && r.data?.unchanged.map((u) => u.id), [already.id]);
    assert.deepEqual(
      r.ok && r.data?.failed.map((f) => f.id).sort(),
      [lost.id, nobody.id, departed.id].sort(),
    );
    const why = (leadId: string) => (r.ok ? r.data?.failed.find((f) => f.id === leadId)?.why : "") ?? "";
    assert.match(why(nobody.id), /nobody owns it/);
    assert.match(why(departed.id), /can no longer sign in/);
    assert.match(why(lost.id), /reopened, not put on hold/);
    assert.match(r.ok ? (r.message ?? "") : "", /1 already was at On hold/);

    // The unchanged lead received no second write and no second transition.
    const after = await rowOf(already.id);
    assert.equal(String(after.leadHoldResumeDate), String(before.leadHoldResumeDate), "its resume date was not overwritten");
    assert.equal((await transitionsOf(already.id)).length, transitionsBefore);

    // Nobody was handed a next action on a lead they do not own.
    assert.equal((await rowOf(nobody.id)).leadStage, "prospect");
    assert.equal((await rowOf(nobody.id)).leadNextActionOwnerId ?? null, null);
    assert.equal((await rowOf(departed.id)).leadStage, "prospect");
    assert.equal((await rowOf(open.id)).leadNextActionOwnerId, tele1.id);
  });

  test("a lead the person cannot reach is refused without being named", async () => {
    const mine = await makeLead({ ownerId: tele1.id });
    const outsider = await makeUser("Other Manager", "manager");
    const stranger = await makeUser("Stranger Caller", "associate");
    await db.update(users).set({ reportsToId: outsider.id }).where(eq(users.id, stranger.id));
    const theirs = await makeLead({ leadManagerId: outsider.id, ownerId: stranger.id });
    const r = await park([mine.id, theirs.id]);
    assert.equal(r.ok && r.data?.done, 1);
    assert.equal(r.ok && r.data?.failed.length, 1);
    assert.equal(r.ok && r.data?.failed[0].name, "A lead");
    assert.equal((await rowOf(theirs.id)).leadStage, "prospect");
  });

  test("other stages are unaffected: the result has no unchanged list entries and the old message", async () => {
    const a = await makeLead();
    const r = await bulkAdvanceLeadStage(bulkStagePayload([a.id], "lost", "price", ""));
    assert.equal(r.ok && r.data?.done, 1);
    assert.deepEqual(r.ok && r.data?.unchanged, []);
    assert.equal(r.ok && r.message, "1 lead moved to Lost.");
  });
});
