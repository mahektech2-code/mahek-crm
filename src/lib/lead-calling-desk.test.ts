/**
 * The calling desk, end to end: the three calls, Ready for Prospect, and — the
 * point of the feature — that ASKING for a Prospect is not being one.
 *
 * Runs against mahekone_test with the real actions and the real services —
 * scope, capabilities, the audit log and the stage gate are all the real thing,
 * because this feature adds no mechanism of its own and the way to prove that
 * is to drive the existing ones.
 *
 * What is pinned, in the order it was asked for:
 *
 *   A  ready as soon as the five answers are in, with no third call forced;
 *   R  the request: the lead STAYS a Suspect, it is with the manager, and only
 *      a successful verification moves the rung;
 *   M  the manager's three outcomes, and the one thing the form has no outcome
 *      for — sending it back — with the desk resubmitting or closing it;
 *   B  Call 3 becomes the call owed after two incomplete ones;
 *   C  Call 3 finished and still short is Lost, and there is no Call 4;
 *   D  what one call captured is not asked, and not overwritten, by the next;
 *   S  the salesman's own path is untouched by any of it.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  calls,
  customers,
  leadStageTransitions,
  mbosTasks,
  notifications,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import {
  logDeskMessage,
  logQualificationCall,
  markDeskLost,
  requestProspect,
  returnProspectRequest,
  setDeskNextAction,
} from "@/lib/actions/lead-calling-desk";
import { recordLeadValidationCall } from "@/lib/actions/leads";
import {
  callingDesk,
  deskLeadRecord,
  prospectRequestFor,
} from "@/lib/services/lead-calling-desk-service";
import { verificationQueue } from "@/lib/services/lead-console-service";
import { questionsForCall } from "@/lib/engines/lead-calling-desk";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const DAY = "2026-09-24";
const tomorrow = "2026-12-01";

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
      ...over,
    })
    .returning();
  return row;
}

const call1 = () => ({ monthlyLitres: 200, requiredProductId: productId, competitor: "Local thinner" });
const call2 = { decisionMaker: "Owner himself", potentialPaise: 6_000_000 };

/** A lead the desk has qualified completely, ready to be asked for. */
async function readyLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const lead = await makeLead(over);
  const r = await logQualificationCall({
    customerId: lead.id,
    outcome: "spoke_collected",
    answers: { ...call1(), ...call2 },
  });
  assert.equal(r.ok && r.data.result, "ready", r.ok ? "" : r.error);
  return lead;
}

const ask = (customerId: string, extra: Partial<Parameters<typeof requestProspect>[0]> = {}) =>
  requestProspect({
    customerId,
    reasonCode: "regular_requirement",
    customerType: "manufacturer",
    note: "Wants a trial first.",
    ...extra,
  });

const stageOf = async (leadId: string) =>
  (await db.select().from(customers).where(eq(customers.id, leadId)))[0];

/** The manager rings and records a verification outcome — the existing action. */
async function managerVerifies(leadId: string, outcome: "verified" | "follow_up" | "not_qualified") {
  setTestUser(manager);
  const r = await recordLeadValidationCall(leadId, {
    answers: {},
    outcome,
    followUpNote: outcome === "verified" ? undefined : "The buyer was not on the call.",
    failureReasonCode: outcome === "not_qualified" ? "denies_enquiry" : undefined,
  });
  return r;
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
    truncate table lead_stage_transitions, lead_verification_corrections, mbos_lead_validations, mbos_tasks,
      calls, notifications, timeline_events, audit_log, app_access, customers, products, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  desk = await makeUser("Desk Caller", "associate");
  other = await makeUser("Other Caller", "associate");
  manager = await makeUser("Sales Manager", "manager");
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
  setTestUser(desk);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("Test A — ready after Call 2, with no third call forced", () => {
  test("Call 1 partial, Call 2 completes the five", async () => {
    const lead = await makeLead();
    const one = await logQualificationCall({
      customerId: lead.id,
      outcome: "spoke_callback",
      answers: call1(),
      next: { kind: "call", text: "the rest", date: tomorrow },
    });
    assert.equal(one.ok, true, one.ok ? "" : one.error);
    assert.equal(one.ok && one.data.result, "next");
    assert.equal((await deskLeadRecord(lead.id, DAY))?.phase, "call2");

    const two = await logQualificationCall({ customerId: lead.id, outcome: "spoke_collected", answers: call2 });
    assert.equal(two.ok && two.data.result, "ready");

    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.phase, "ready");
    assert.equal(rec?.callCount, 2);
    const row = await stageOf(lead.id);
    assert.equal(row.leadStage, "suspect", "ready is derived, never stored");
    assert.equal(row.leadNextAction, "Request Prospect");

    const three = await logQualificationCall({ customerId: lead.id, outcome: "spoke_callback", answers: {} });
    assert.equal(three.ok, false, "no further call on a lead that is ready");
  });

  test("all five on Call 1 is ready straight away, and the twelve answers include the enquiry's own", async () => {
    const lead = await makeLead({ email: "ganesh@shop.in", address: "Shop 12, Nashik" });
    const r = await logQualificationCall({
      customerId: lead.id,
      outcome: "spoke_collected",
      answers: { ...call1(), ...call2, buyer: "Purchase head", creditDaysWanted: 30 },
    });
    assert.equal(r.ok && r.data.result, "ready");
    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.values.buyer, "Purchase head");
    assert.equal(rec?.values.email, "ganesh@shop.in");
    assert.equal(rec?.answeredOn.email, undefined, "an answer that came with the enquiry names no call");
    assert.equal(rec?.answeredOn.buyer, 1);
  });
});

describe("Test R — Request Prospect is a request, not a Prospect", () => {
  test("the lead stays a Suspect and goes to the manager as awaiting verification", async () => {
    const lead = await readyLead();
    const sent = await ask(lead.id);
    assert.equal(sent.ok, true, sent.ok ? "" : sent.error);

    const row = await stageOf(lead.id);
    assert.equal(row.leadStage, "suspect", "a request must NOT move the rung");
    assert.equal(row.prospectRequestState, "awaiting");
    assert.equal(row.prospectRequestReason, "regular_requirement");
    assert.equal(row.prospectRequestNote, "Wants a trial first.");
    assert.equal(row.prospectRequestedById, desk.id);
    assert.ok(row.prospectRequestedAt);
    assert.equal(row.customerType, "manufacturer");
    assert.equal(row.leadManagerId, manager.id);
    assert.equal(row.leadNextActionOwnerId, manager.id);
    assert.equal(row.leadNextAction, "Sales manager verification");
    assert.equal(row.leadVerifiedAt, null);

    const moves = await db.select().from(leadStageTransitions).where(eq(leadStageTransitions.customerId, lead.id));
    assert.equal(moves.length, 0, "no stage transition was written");

    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.phase, "requested");
    assert.equal(rec?.ladder[rec.ladderIndex], "suspect");

    const bells = await db.select().from(notifications).where(eq(notifications.userId, manager.id));
    assert.equal(bells.length, 1);
    assert.match(bells[0].href ?? "", /\/verify$/);
  });

  test("while it is with the manager the desk cannot ring, re-ask, message-close or close it", async () => {
    const lead = await readyLead();
    await ask(lead.id);
    const call = await logQualificationCall({ customerId: lead.id, outcome: "spoke_callback", answers: {} });
    assert.equal(call.ok, false);
    assert.equal((await ask(lead.id)).ok, false, "already with the manager");
    const lost = await markDeskLost({ customerId: lead.id, reasonCode: "other" });
    assert.equal(lost.ok, false, "a lead the manager holds is theirs to close");
    assert.equal((await stageOf(lead.id)).leadStage, "suspect");
  });

  test("it is refused until every required answer is in", async () => {
    const lead = await makeLead();
    await logQualificationCall({
      customerId: lead.id,
      outcome: "spoke_callback",
      answers: call1(),
      next: { kind: "call", text: "the rest", date: tomorrow },
    });
    const r = await ask(lead.id, { customerType: "dealer" });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /Decision maker/);
    assert.equal((await stageOf(lead.id)).prospectRequestState, null);
  });

  test("it asks for the two things the Prospect gate wants that are not among the five", async () => {
    const lead = await readyLead({ contactPerson: null });
    const r = await requestProspect({ customerId: lead.id, reasonCode: "regular_requirement" });
    assert.equal(r.ok, false, "no business type or contact was given");
    assert.equal((await stageOf(lead.id)).prospectRequestState, null, "a refused request writes nothing");
    const again = await ask(lead.id, { contactPerson: "Ganesh Pawar" });
    assert.equal(again.ok, true, again.ok ? "" : again.error);
  });

  test("a lead nobody has said how to sell makes the desk choose — it is never defaulted to Direct", async () => {
    const lead = await readyLead({ leadSalesType: null });
    const refused = await ask(lead.id);
    assert.equal(refused.ok, false);
    assert.match(!refused.ok ? refused.error : "", /sales type|how this lead will be sold/i);
    assert.ok(
      !refused.ok && refused.fieldErrors?.some((f) => f.field === "salesType"),
      "the refusal names the field the dialog has to draw an error under",
    );
    const untouched = await stageOf(lead.id);
    assert.equal(untouched.leadSalesType, null, "a refused request writes nothing, the type included");
    assert.equal(untouched.prospectRequestState, null);

    const chosen = await ask(lead.id, { salesType: "third_party" });
    assert.equal(chosen.ok, true, chosen.ok ? "" : chosen.error);
    const row = await stageOf(lead.id);
    assert.equal(row.leadSalesType, "third_party", "the chosen type is what is stored");
    assert.equal(row.prospectRequestState, "awaiting");
    assert.equal(row.leadStage, "suspect");
    const [audited] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from audit_log where action = 'lead.salesType.set' and entity_id = ${lead.id}`,
    );
    assert.equal(audited.n, 1, "choosing a type is audited like every other time it is chosen");
  });

  test("a lead that already has a sales type is not asked for one, and a stray value cannot change it", async () => {
    const lead = await readyLead({ leadSalesType: "direct" });
    const r = await ask(lead.id, { salesType: "third_party" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await stageOf(lead.id)).leadSalesType, "direct");
  });

  test("the request's own columns cannot describe an impossible state", async () => {
    const lead = await makeLead();
    /* The driver wraps the database's own message, so the constraint's name is on the cause. */
    const named = (re: RegExp) => (e: unknown) => re.test(String((e as { cause?: Error }).cause?.message ?? e));
    await assert.rejects(
      db.execute(sql`update customers set prospect_request_state = 'awaiting' where id = ${lead.id}`),
      named(/prospect_request_has_when/),
    );
    await assert.rejects(
      db.execute(sql`update customers set prospect_request_state = 'maybe', prospect_requested_at = now() where id = ${lead.id}`),
      named(/prospect_request_state_check/),
    );
  });
});

describe("Test M — the manager settles it", () => {
  test("Verified: only now does the lead become a Prospect, and the desk is told", async () => {
    const lead = await readyLead();
    await ask(lead.id);
    setTestUser(desk);
    assert.equal((await stageOf(lead.id)).leadStage, "suspect");

    const v = await managerVerifies(lead.id, "verified");
    assert.equal(v.ok, true, v.ok ? "" : v.error);
    assert.match(v.ok ? (v.message ?? "") : "", /Prospect/);

    const row = await stageOf(lead.id);
    assert.equal(row.leadStage, "prospect");
    assert.equal(row.prospectRequestState, null, "the request is answered");
    assert.equal(row.prospectRequestReason, "regular_requirement", "and its history is kept");
    assert.ok(row.leadVerifiedAt);
    assert.equal(row.leadManagerId, manager.id);
    assert.equal(row.leadNextAction, "Start qualification");

    const moves = await db.select().from(leadStageTransitions).where(eq(leadStageTransitions.customerId, lead.id));
    assert.equal(moves.length, 1);
    assert.equal(moves[0].toStage, "prospect");
    assert.equal(moves[0].reasonCode, "regular_requirement");
    assert.equal(moves[0].actorId, manager.id, "the promotion is the manager's own act");

    const bells = await db.select().from(notifications).where(eq(notifications.userId, desk.id));
    assert.ok(bells.some((b) => /Prospect/.test(b.title)));

    setTestUser(desk);
    assert.equal((await deskLeadRecord(lead.id, DAY))?.phase, "prospect");
  });

  test("Follow-up: it stays a Suspect, on hold, and the desk gets the manager's task", async () => {
    const lead = await readyLead();
    await ask(lead.id);
    const v = await managerVerifies(lead.id, "follow_up");
    assert.equal(v.ok, true, v.ok ? "" : v.error);

    const row = await stageOf(lead.id);
    assert.equal(row.leadStage, "suspect");
    assert.equal(row.prospectRequestState, "followup");

    const tasks = await db.select().from(mbosTasks).where(eq(mbosTasks.customerId, lead.id));
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].assignedToUserId, desk.id);

    setTestUser(desk);
    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.phase, "followup");
    assert.equal(rec?.managerNote, "The buyer was not on the call.");

    /* Verifying it properly afterwards is what promotes it. */
    const later = await managerVerifies(lead.id, "verified");
    assert.equal(later.ok, true, later.ok ? "" : later.error);
    assert.equal((await stageOf(lead.id)).leadStage, "prospect");
  });

  test("Return to the Telecaller: it comes back with the manager's note, still a Suspect", async () => {
    const lead = await readyLead();
    await ask(lead.id);
    setTestUser(manager);
    assert.equal((await returnProspectRequest({ customerId: lead.id, note: "" })).ok, false, "a return needs its note");
    const r = await returnProspectRequest({ customerId: lead.id, note: "He only wanted a price list." });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const row = await stageOf(lead.id);
    assert.equal(row.leadStage, "suspect");
    assert.equal(row.prospectRequestState, "returned");
    assert.equal(row.leadNextActionOwnerId, desk.id, "the next move is the desk's again");

    setTestUser(desk);
    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.phase, "returned");
    assert.equal(rec?.managerNote, "He only wanted a price list.");
    const bells = await db.select().from(notifications).where(eq(notifications.userId, desk.id));
    assert.ok(bells.some((b) => /returned/i.test(b.title) && /price list/.test(b.body)));

    const ring = await logQualificationCall({ customerId: lead.id, outcome: "spoke_callback", answers: {} });
    assert.equal(ring.ok, false, "a returned lead is resubmitted or closed, never rung");
  });

  test("Returned → Resubmit: it goes back to awaiting, and the manager can verify it", async () => {
    const lead = await readyLead();
    await ask(lead.id);
    setTestUser(manager);
    await returnProspectRequest({ customerId: lead.id, note: "Confirm the decision maker." });
    setTestUser(desk);

    const again = await ask(lead.id, { note: "Confirmed with the owner." });
    assert.equal(again.ok && again.data.resubmitted, true, again.ok ? "" : again.error);
    const row = await stageOf(lead.id);
    assert.equal(row.prospectRequestState, "awaiting");
    assert.equal(row.prospectRequestNote, "Confirmed with the owner.");
    assert.equal(row.leadStage, "suspect");

    const v = await managerVerifies(lead.id, "verified");
    assert.equal(v.ok, true, v.ok ? "" : v.error);
    assert.equal((await stageOf(lead.id)).leadStage, "prospect");
  });

  test("Returned → Mark Lost: the desk closes it under the configured reason, in its own words", async () => {
    const lead = await readyLead();
    await ask(lead.id);
    setTestUser(manager);
    await returnProspectRequest({ customerId: lead.id, note: "Not a real requirement." });
    setTestUser(desk);

    const lost = await markDeskLost({ customerId: lead.id, reasonCode: "not_genuine", note: "Confirmed by the manager." });
    assert.equal(lost.ok, true, lost.ok ? "" : lost.error);
    const row = await stageOf(lead.id);
    assert.equal(row.leadStage, "lost");
    assert.equal(row.leadLostReason, "no_requirement", "filed under an existing configured code");
    const [move] = await db
      .select()
      .from(leadStageTransitions)
      .where(eq(leadStageTransitions.customerId, lead.id))
      .orderBy(desc(leadStageTransitions.at));
    assert.match(move.note ?? "", /Requirement not genuine/);
    assert.equal((await deskLeadRecord(lead.id, DAY))?.phase, "lost");
  });

  test("Not qualified: the existing closure, untouched", async () => {
    const lead = await readyLead();
    await ask(lead.id);
    const v = await managerVerifies(lead.id, "not_qualified");
    assert.equal(v.ok, true, v.ok ? "" : v.error);
    assert.equal((await stageOf(lead.id)).leadStage, "lost");
  });

  test("a return needs a pending request, and is a manager's act", async () => {
    const lead = await readyLead();
    setTestUser(manager);
    assert.equal((await returnProspectRequest({ customerId: lead.id, note: "x" })).ok, false, "nothing pending");
    setTestUser(desk);
    await ask(lead.id);
    const byDesk = await returnProspectRequest({ customerId: lead.id, note: "sending my own back" });
    assert.equal(byDesk.ok, false, "the desk cannot return its own request");
  });

  test("the manager finds the request in the verification queue, marked, and the notice reads it", async () => {
    const lead = await readyLead();
    await ask(lead.id);
    setTestUser(manager);
    const q = await verificationQueue(DAY);
    const row = q.rows.find((r) => r.customerId === lead.id);
    assert.ok(row, "a request waits in the manager's queue");
    assert.equal(row.requested, true);
    const notice = await prospectRequestFor(lead.id);
    assert.equal(notice?.state, "awaiting");
    assert.equal(notice?.requestedByName, "Desk Caller");
    assert.equal(notice?.reasonCode, "regular_requirement");
  });
});

describe("Test S — the salesman's own path is untouched", () => {
  test("verifying a lead with no request changes no stage and no request state", async () => {
    const suspect = await makeLead({ ownerId: desk.id, leadManagerId: manager.id });
    const prospect = await makeLead({ ownerId: desk.id, leadStage: "prospect", leadManagerId: manager.id });
    for (const lead of [suspect, prospect]) {
      const v = await managerVerifies(lead.id, "verified");
      assert.equal(v.ok, true, v.ok ? "" : v.error);
    }
    assert.equal((await stageOf(suspect.id)).leadStage, "suspect", "a verification alone does not promote");
    const p = await stageOf(prospect.id);
    assert.equal(p.leadStage, "prospect");
    assert.ok(p.leadVerifiedAt);
    assert.equal(p.prospectRequestState, null);
  });

  test("a lead the desk never asked for does not appear as a request in the queue", async () => {
    const prospect = await makeLead({ ownerId: desk.id, leadStage: "prospect", leadStageSince: DAY });
    setTestUser(manager);
    const row = (await verificationQueue(DAY)).rows.find((r) => r.customerId === prospect.id);
    assert.ok(row);
    assert.equal(row.requested, false);
  });
});

describe("Test B — Call 3 becomes available", () => {
  test("two incomplete calls make Call 3 the one owed, and it is accepted", async () => {
    const lead = await makeLead();
    await logQualificationCall({ customerId: lead.id, outcome: "spoke_callback", answers: { monthlyLitres: 200 }, next: { kind: "call", text: "x", date: tomorrow } });
    await logQualificationCall({ customerId: lead.id, outcome: "no_answer", noAnswerReason: "busy", answers: {}, next: { kind: "call", text: "x", date: tomorrow } });
    assert.equal((await deskLeadRecord(lead.id, DAY))?.phase, "call3");

    const three = await logQualificationCall({ customerId: lead.id, outcome: "spoke_callback", answers: { competitor: "Asian" } });
    assert.equal(three.ok, true, three.ok ? "" : three.error);
    assert.equal(three.ok && three.data.callNumber, 3);
  });

  test("a call's next step is stored, typed, and read back as a call or a message", async () => {
    const lead = await makeLead();
    await logQualificationCall({
      customerId: lead.id,
      outcome: "spoke_callback",
      answers: { monthlyLitres: 200 },
      next: { kind: "message", text: "Send information on WhatsApp, then ring back", date: tomorrow },
    });
    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.nextAction?.kind, "message");
    assert.equal(rec?.calls[0].nextAction, "Send information on WhatsApp, then ring back");
    assert.equal(rec?.calls[0].nextDate, tomorrow);

    const set = await setDeskNextAction({ customerId: lead.id, kind: "call", text: "ask about credit", date: tomorrow });
    assert.equal(set.ok, true, set.ok ? "" : set.error);
    const after = await deskLeadRecord(lead.id, DAY);
    assert.equal(after?.nextAction?.text, "Call 2 — ask about credit");
    assert.equal(after?.nextAction?.kind, "call");
  });
});

describe("Test C — lost after Call 3, and no Call 4", () => {
  async function threeShortCalls(leadId: string) {
    await logQualificationCall({ customerId: leadId, outcome: "spoke_callback", answers: { monthlyLitres: 200 }, next: { kind: "call", text: "x", date: tomorrow } });
    await logQualificationCall({ customerId: leadId, outcome: "spoke_callback", answers: { competitor: "Local" }, next: { kind: "call", text: "x", date: tomorrow } });
    return logQualificationCall({ customerId: leadId, outcome: "spoke_callback", answers: {} });
  }

  test("Call 3 finished and still short closes the lead as lost", async () => {
    const lead = await makeLead();
    const last = await threeShortCalls(lead.id);
    assert.equal(last.ok, true, last.ok ? "" : last.error);
    assert.equal(last.ok && last.data.result, "lost");
    const row = await stageOf(lead.id);
    assert.equal(row.leadStage, "lost");
    assert.ok(row.leadLostReason);
    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.phase, "lost");
    assert.match(rec?.calls[2].finalDisposition ?? "", /Lost/);
    assert.match(rec?.lost?.detail ?? "", /Three qualification calls/);
    assert.ok(rec?.lost?.deskLabel, "the desk's own label is read back off the note");
  });

  test("the desk's own lost reason is honoured, filed under a configured code", async () => {
    const lead = await makeLead();
    await logQualificationCall({ customerId: lead.id, outcome: "spoke_callback", answers: { monthlyLitres: 200 }, next: { kind: "call", text: "x", date: tomorrow } });
    await logQualificationCall({ customerId: lead.id, outcome: "no_answer", noAnswerReason: "busy", answers: {}, next: { kind: "call", text: "x", date: tomorrow } });
    await logQualificationCall({ customerId: lead.id, outcome: "no_answer", noAnswerReason: "busy", answers: {}, lostReasonCode: "not_genuine" });
    assert.equal((await stageOf(lead.id)).leadLostReason, "no_requirement");
  });

  test("there is no Call 4 — by the stage, and by the count if the lead is put back", async () => {
    const lead = await makeLead();
    await threeShortCalls(lead.id);
    assert.equal((await logQualificationCall({ customerId: lead.id, outcome: "spoke_callback", answers: {} })).ok, false);

    await db.update(customers).set({ leadStage: "suspect" }).where(eq(customers.id, lead.id));
    const count = await logQualificationCall({ customerId: lead.id, outcome: "spoke_callback", answers: {} });
    assert.equal(count.ok, false);
    assert.match(!count.ok ? count.error : "", /no Call 4/i);
    assert.equal((await db.select().from(calls).where(eq(calls.customerId, lead.id))).length, 3);
  });

  test("the last answer arriving on Call 3 is ready, not lost", async () => {
    const lead = await makeLead();
    await logQualificationCall({ customerId: lead.id, outcome: "spoke_callback", answers: call1(), next: { kind: "call", text: "x", date: tomorrow } });
    await logQualificationCall({ customerId: lead.id, outcome: "spoke_callback", answers: { decisionMaker: "Owner" }, next: { kind: "call", text: "x", date: tomorrow } });
    const last = await logQualificationCall({ customerId: lead.id, outcome: "spoke_collected", answers: { potentialPaise: 6_000_000 } });
    assert.equal(last.ok && last.data.result, "ready");
    assert.equal((await stageOf(lead.id)).leadStage, "suspect");
  });

  test("not interested and a wrong number close it at once, with the right reason", async () => {
    const a = await makeLead();
    const b = await makeLead();
    await logQualificationCall({ customerId: a.id, outcome: "not_interested", answers: {} });
    await logQualificationCall({ customerId: b.id, outcome: "wrong_number", answers: {} });
    assert.equal((await stageOf(a.id)).leadLostReason, "not_interested");
    assert.equal((await stageOf(b.id)).leadLostReason, "wrong_lead");
  });
});

describe("Test D — no question is asked twice", () => {
  test("what Call 1 captured is not offered on Call 2 and is not overwritten by it", async () => {
    const lead = await makeLead();
    await logQualificationCall({ customerId: lead.id, outcome: "spoke_callback", answers: { monthlyLitres: 200, competitor: "Local thinner" }, next: { kind: "call", text: "x", date: tomorrow } });

    const rec = await deskLeadRecord(lead.id, DAY);
    assert.ok(rec);
    const q = questionsForCall(rec.values, 2);
    const offered = [...q.askNow, ...q.later].map((f) => f.key);
    assert.ok(!offered.includes("monthlyLitres") && !offered.includes("competitor"));
    assert.deepEqual(rec.answeredOn, { monthlyLitres: 1, competitor: 1 });

    const second = await logQualificationCall({ customerId: lead.id, outcome: "spoke_collected", answers: { monthlyLitres: 999, decisionMaker: "Owner" }, next: { kind: "call", text: "x", date: tomorrow } });
    assert.equal(second.ok, true, second.ok ? "" : second.error);
    assert.match(second.ok ? (second.warnings?.[0] ?? "") : "", /Monthly requirement/);
    const row = await stageOf(lead.id);
    assert.equal(row.leadMonthlyVolumeLitres, 200, "Call 1's figure stands");
    assert.equal(row.leadDecisionMaker, "Owner");
    assert.deepEqual((await deskLeadRecord(lead.id, DAY))?.answeredOn, { monthlyLitres: 1, competitor: 1, decisionMaker: 2 });
  });
});

describe("the call's own rules", () => {
  test("'information collected' with nothing captured is refused, and a refused call leaves nothing behind", async () => {
    const lead = await makeLead();
    assert.equal((await logQualificationCall({ customerId: lead.id, outcome: "spoke_collected", answers: {} })).ok, false);
    assert.equal((await db.select().from(calls).where(eq(calls.customerId, lead.id))).length, 0);
  });

  test("a no answer has to say what kind, and cannot have captured anything", async () => {
    const lead = await makeLead();
    assert.equal((await logQualificationCall({ customerId: lead.id, outcome: "no_answer", answers: {} })).ok, false);
    assert.equal((await logQualificationCall({ customerId: lead.id, outcome: "no_answer", noAnswerReason: "busy", answers: { competitor: "Asian" } })).ok, false);
    assert.equal((await logQualificationCall({ customerId: lead.id, outcome: "no_answer", noAnswerReason: "busy", answers: {} })).ok, true);
  });

  test("a lead past the Suspect rung is not the desk's to ring", async () => {
    const lead = await makeLead({ leadStage: "qualification" });
    assert.equal((await logQualificationCall({ customerId: lead.id, outcome: "spoke_callback", answers: {} })).ok, false);
  });

  test("a message uses no call, is read back on the record, and answers a waiting message follow-up", async () => {
    const lead = await makeLead({ leadNextAction: "Send information on WhatsApp, then ring back", leadNextActionDate: DAY });
    const r = await logDeskMessage({ customerId: lead.id, code: "brochure", note: "Sent after the call." });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.callCount, 0, "no call was used");
    assert.equal(rec?.messages.length, 1);
    assert.equal(rec?.messages[0].code, "brochure");
    assert.equal(rec?.messages[0].note, "Sent after the call.");
    assert.equal(rec?.nextAction?.text, "Call 1 — after the message");
    assert.equal((await logDeskMessage({ customerId: lead.id, code: "smoke_signal" })).ok, false);
  });
});

describe("scope and the dashboard's tiles", () => {
  test("another caller's lead cannot be rung, asked for or opened", async () => {
    const theirs = await makeLead({ ownerId: other.id });
    assert.equal((await logQualificationCall({ customerId: theirs.id, outcome: "spoke_callback", answers: {}, next: { kind: "call", text: "x", date: tomorrow } })).ok, false);
    assert.equal(await deskLeadRecord(theirs.id, DAY), null, "a lead that is not yours answers like one that does not exist");
  });

  test("every tile counts exactly what its list holds, the lifecycle agrees, and the side cards read the request", async () => {
    await makeLead({ name: "Fresh" });
    const second = await makeLead({ name: "Second", leadNextAction: "Call 2 — the rest", leadNextActionDate: DAY });
    await makeLead({ name: "Walked in", leadSource: "Walk-in" });
    await makeLead({ name: "Their lead", ownerId: other.id });
    const ready = await readyLead({ name: "Ready" });
    const asked = await readyLead({ name: "Asked" });
    const sent = await readyLead({ name: "Sent back" });

    await logQualificationCall({ customerId: second.id, outcome: "spoke_callback", answers: { monthlyLitres: 100 }, next: { kind: "call", text: "the rest", date: tomorrow } });
    await ask(asked.id);
    await ask(sent.id);
    setTestUser(manager);
    await returnProspectRequest({ customerId: sent.id, note: "Fix the potential." });
    setTestUser(desk);
    void ready;

    const d = await callingDesk(DAY, "queue");
    assert.equal(d.tiles.all, 6, "own book only — Their lead is another caller's");
    assert.equal(d.tiles.ready, 1);
    assert.equal(d.tiles.requested, 1);
    assert.equal(d.tiles.verify, 1);
    assert.equal(d.tiles.returned, 1);
    assert.equal(d.tiles.handed, 2, "everything the desk asked for and is not lost");
    assert.equal(d.tiles.call2, 1);
    assert.equal(d.tiles.new, 1, "Fresh only — Walked in is not online, Second has been rung");
    assert.equal(d.tiles.prospect, 0, "a request is not a Prospect");

    const suspect = d.lifecycle.find((c) => c.key === "suspect");
    const prospect = d.lifecycle.find((c) => c.key === "prospect");
    assert.equal(suspect?.count, 6, "every one of them is still a Suspect");
    assert.equal(prospect?.count, 0);
    assert.equal(prospect?.waiting, 1, "the request waiting on the manager is drawn on the Prospect rung");

    assert.deepEqual(d.pending.map((r) => r.name).sort(), ["Asked", "Sent back"]);
    assert.deepEqual(d.ready.map((r) => r.name), ["Ready"]);

    for (const view of ["queue", "all", "new", "today", "followups", "overdue", "call1", "call2", "call3", "ready", "suspect", "verify", "requested", "returned", "handed", "prospect", "lost"] as const) {
      const list = await callingDesk(DAY, view);
      assert.equal(list.total, list.tiles[view], `${view}: the tile and the list disagree`);
    }
  });
});

/** What the screen would toast: the message on success, the reason on refusal. */
const said = (r: { ok: true; message?: string } | { ok: false; error: string }) => (r.ok ? r.message : r.error);

describe("round three: the record reads the way V6 draws it", () => {
  test("a lead with no sales type is drawn on the Direct ladder, and carries a readable reference", async () => {
    const lead = await makeLead({ leadSalesType: null });
    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.salesType, null, "drawing the Direct ladder does not decide it");
    assert.ok(rec?.ladder.includes("prospect"), "not the six-rung legacy ladder");
    assert.equal(rec?.ladder.length, 12);
    assert.equal(rec?.ladderIndex, 0);
    assert.match(rec?.reference ?? "", /^TC-\d{4,}$/);
    assert.ok(!(rec?.reference ?? "").includes(lead.id.slice(-8)), "never a slice of the id");
    const second = await makeLead();
    assert.notEqual((await deskLeadRecord(second.id, DAY))?.reference, rec?.reference);
  });

  test("a lost Suspect keeps its rung and its progress, and the desk's reason is read back apart from the detail", async () => {
    const lead = await makeLead();
    await logQualificationCall({ customerId: lead.id, outcome: "spoke_callback", answers: { monthlyLitres: 100 }, next: { kind: "call", text: "x", date: tomorrow } });
    const lost = await markDeskLost({ customerId: lead.id, reasonCode: "not_interested", note: "Went with a local supplier" });
    assert.equal(lost.ok, true, lost.ok ? "" : lost.error);
    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.phase, "lost");
    assert.equal(rec?.ladderIndex, 0, "Suspect, not 'Stage 0'");
    assert.equal(rec?.lost?.deskLabel, "Customer not interested");
    assert.equal(rec?.lost?.detail, "Went with a local supplier");
    const d = await callingDesk(DAY, "lost");
    assert.equal(d.rows[0]?.ladderKey, "suspect");
    assert.equal(d.lifecycle.find((c) => c.key === "suspect")?.count, 0, "a lost lead is counted on no rung");
  });

  test("a lead lost further up keeps that rung", async () => {
    const lead = await makeLead({ leadStage: "qualification" });
    await db.insert(leadStageTransitions).values({
      id: id("lst"),
      customerId: lead.id,
      fromStage: "qualification",
      toStage: "lost",
      salesType: "direct",
      kind: "passed",
      note: "Other — closed by the manager",
      reasonCode: "other",
    });
    await db.update(customers).set({ leadStage: "lost", leadLostReason: "other" }).where(eq(customers.id, lead.id));
    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.phase, "lost");
    assert.equal(rec?.ladder[rec.ladderIndex], "qualification");
  });

  test("the toasts use V6's words, with the short date and the manager's own name", async () => {
    const lead = await makeLead();
    const one = await logQualificationCall({
      customerId: lead.id,
      outcome: "spoke_callback",
      answers: call1(),
      next: { kind: "call", text: "the rest", date: "2026-12-05" },
    });
    assert.ok(one.ok);
    assert.equal(said(one), "Call 1 / 3 saved. Call 2 due 5 Dec.");

    const two = await logQualificationCall({ customerId: lead.id, outcome: "spoke_collected", answers: call2 });
    assert.equal(said(two), "Call 2 / 3 saved. All required answers collected — Ready for Prospect.");

    const other = await makeLead();
    const msg = await logQualificationCall({
      customerId: other.id,
      outcome: "spoke_callback",
      answers: {},
      next: { kind: "message", text: "Send the price list", date: "2026-12-06" },
    });
    assert.equal(said(msg), "Call 1 / 3 saved. Message due 6 Dec.");

    const closed = await logQualificationCall({ customerId: other.id, outcome: "not_interested", answers: {} });
    assert.equal(said(closed), "Customer not interested — lead marked Lost.");

    await db.update(customers).set({ leadManagerId: manager.id }).where(eq(customers.id, lead.id));
    const asked = await ask(lead.id);
    assert.ok(asked.ok);
    assert.equal(said(asked), "Prospect requested. Sales Manager verifies it — it is not a Prospect until they confirm.");
  });

  test("a finding the manager could not establish is drawn as unable to verify, beside what they confirmed and corrected", async () => {
    const lead = await readyLead();
    await ask(lead.id);
    const verified = await managerVerifies(lead.id, "verified");
    assert.equal(verified.ok, true, verified.ok ? "" : verified.error);
    /* The field check is the door where "unable to verify" is recorded, with no call to hang it on. */
    await db.execute(sql`
      insert into lead_verification_corrections (id, customer_id, field, verdict, original, corrected, reason, changed_by_id, changed_by_name)
      values (${id("lvc")}, ${lead.id}, 'monthly_litres', 'unverified', '200', null, 'The buyer was not reachable.', ${manager.id}, 'Sales Manager'),
             (${id("lvc")}, ${lead.id}, 'competitor', 'corrected', 'Local thinner', 'Asian Paints', 'He named a different brand.', ${manager.id}, 'Sales Manager')`);
    setTestUser(desk);
    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.marks.monthlyLitres?.kind, "unverified");
    assert.equal(rec?.marks.competitor?.kind, "corrected");
    assert.equal(rec?.marks.competitor?.was, "Local thinner");
    assert.equal(rec?.marks.decisionMaker?.kind, "confirmed", "a passed verification confirms what nothing contradicted");
    assert.ok(rec?.verification && rec.verification.attempt >= 1);
    assert.equal(rec?.verification?.counts.unable, 1);
    assert.equal(rec?.verification?.counts.corrected, 1);
  });

  test("a sample and an order are read back with their real facts, the milestones off the ledger", async () => {
    const lead = await makeLead({ leadStage: "first_order", leadSalesType: "direct" });
    await db.execute(sql`
      insert into orders (id, customer_id, ordered_at, total_amount, status, order_no, line_items, delivery_confirmed_at)
      values (${id("ord")}, ${lead.id}, '2026-09-10T05:00:00Z', 1000000, 'delivered', 'ORD-1', ${JSON.stringify([
        { product: "PU Thinner - 20 Liter (Loose)", quantity: 5, unitPrice: 200000, amount: 1000000 },
      ])}::jsonb, '2026-09-14T05:00:00Z')`);
    const rec = await deskLeadRecord(lead.id, DAY);
    assert.equal(rec?.order?.orderNo, "ORD-1");
    assert.equal(rec?.order?.amountPaise, 1000000);
    assert.equal(rec?.order?.quantityCans, 5);
    assert.equal(rec?.order?.product, "PU Thinner - 20 Liter (Loose)");
    assert.equal(rec?.milestones.first_order, "2026-09-10");
    assert.equal(rec?.milestones.delivery, "2026-09-14");
  });

  test("the timeline is told oldest first, and says what the system and the customer did", async () => {
    const lead = await readyLead({ leadSource: "Website / Online Enquiry", leadNotes: "Need thinner for a spray booth" });
    await ask(lead.id);
    const rec = await deskLeadRecord(lead.id, DAY);
    const times = (rec?.timeline ?? []).map((t) => Date.parse(t.at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b), "oldest first");
    assert.match(rec?.timeline[0]?.title ?? "", /Online enquiry received/);
    assert.match(rec?.timeline[0]?.title ?? "", /Need thinner for a spray booth/);
    assert.equal(rec?.timeline[0]?.who, "system");
    const i = (rec?.timeline ?? []).findIndex((t) => /Prospect requested/.test(t.title));
    assert.ok(i > 0);
    assert.equal(rec?.timeline[i + 1]?.title, "Sales Manager notified — verification task raised");
    assert.equal(rec?.timeline[i + 1]?.who, "system");
    assert.equal(rec?.timeline[i]?.who, "desk");
  });
});
