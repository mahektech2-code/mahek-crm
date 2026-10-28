/**
 * THE EXISTING LEADS PAGE, MADE FUNCTIONAL — the focused checks.
 *
 *   A  who owns a lead they raise (and who does not)
 *   B  Call, Visit and the combined history, and who may log them
 *   C  Option B: a Sales Manager reassigns her own lead from the Leads Page
 *
 * Real services against a scratch `mahekone_test*` database.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, calls, customers, mbosVisits, timelineEvents, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { addDays, type BusinessDate } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { captureLead } from "@/lib/actions/lead-intake";
import { reassignLead } from "@/lib/actions/sales";
import { leadActivityHistoryAction, logLeadCall, logLeadVisit, visitSalesmenAction } from "@/lib/actions/lead-activity";
import { logQualificationCall as realLogQualificationCall } from "@/lib/actions/lead-calling-desk";
import { workableLeadIds } from "@/lib/services/lead-reach-service";
import { DESK_MODULE } from "@/lib/services/lead-desk-assignment-service";

/* Every call needs a remark now; the tests that are not about that supply one. */
const logQualificationCall = (i: Parameters<typeof realLogQualificationCall>[0]) =>
  realLogQualificationCall({ notes: "Spoke to the contact.", ...i });


const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const key = () => randomUUID().replaceAll("-", "").slice(0, 20);

let teleA: typeof users.$inferSelect;
let teleB: typeof users.$inferSelect;
let seema: typeof users.$inferSelect; // Sales Manager, ASSOCIATE level, holds the Sales Manager screen
let boss: typeof users.$inferSelect; // administrator
let plainManager: typeof users.$inferSelect; // manager with neither the desk nor the Sales Manager screen
let salesman: typeof users.$inferSelect;
let tomorrow: string;

async function makeUser(
  name: string,
  role: "associate" | "manager" | "admin",
  app: "crm" | "field",
  modules: string[] = [],
) {
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
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role });
  for (const m of modules) {
    await db.insert(appModuleAccess).values({ id: id("mod"), userId: row.id, app, module: m });
  }
  return row;
}

async function raise(name: string, over: Partial<Parameters<typeof captureLead>[0]> = {}) {
  const r = await captureLead({
    salesType: "direct",
    name,
    phone: String(9100000000 + Math.floor(Math.random() * 99999999)),
    city: "Nashik",
    source: "telecalling",
    ...over,
  });
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.data.customerId;
}

const row = async (customerId: string) =>
  (await db.select().from(customers).where(eq(customers.id, customerId)))[0];

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against a mahekone_test* database.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      mbos_visits, reminders, lead_stage_transitions, mbos_tasks, calls, notifications,
      timeline_events, audit_log, orders, app_secrets, app_module_access, app_access,
      customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  tomorrow = addDays((await today()) as BusinessDate, 1);

  teleA = await makeUser("Telecaller A", "associate", "crm", ["crm.dashboard", "crm.leads", DESK_MODULE]);
  teleB = await makeUser("Telecaller B", "associate", "crm", ["crm.dashboard", "crm.leads", DESK_MODULE]);
  seema = await makeUser("Seema Roy", "associate", "crm", ["crm.dashboard", "crm.leads", "crm.sales-manager"]);
  boss = await makeUser("Office Administrator", "admin", "crm");
  plainManager = await makeUser("Plain Manager", "manager", "crm", ["crm.dashboard", "crm.leads"]);
  salesman = await makeUser("Salesman S", "associate", "field");
  setTestUser(teleA);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("A — who owns a lead they raise", () => {
  test("a Telecaller owns what she raises; the creator is on the append-only event", async () => {
    const leadId = await raise("Tele Lead");
    assert.equal((await row(leadId)).ownerId, teleA.id);
    const [made] = await db
      .select()
      .from(timelineEvents)
      .where(and(eq(timelineEvents.customerId, leadId), eq(timelineEvents.eventType, "lead_created")));
    assert.equal(made.actorUserId, teleA.id);
  });

  test("a Sales Manager owns what she raises — and still holds the Sales Manager seat", async () => {
    setTestUser(seema);
    const l = await row(await raise("Seema Lead"));
    assert.equal(l.ownerId, seema.id);
    assert.equal(l.salesManagerId, seema.id);
  });

  test("a manager or administrator with neither screen still hands the lead to the desk, unassigned", async () => {
    setTestUser(plainManager);
    assert.equal((await row(await raise("Manager Lead"))).ownerId, null);
    setTestUser(boss);
    assert.equal((await row(await raise("Admin Lead"))).ownerId, null);
  });

  test("an explicit null stays unassigned, and a manager viewing a lead changes nobody's ownership", async () => {
    setTestUser(seema);
    assert.equal((await row(await raise("Deliberately Unassigned", { ownerId: null }))).ownerId, null);
    setTestUser(teleA);
    const leadId = await raise("Viewed Lead");
    setTestUser(plainManager);
    await leadActivityHistoryAction(leadId);
    assert.equal((await row(leadId)).ownerId, teleA.id);
  });
});

describe("B — Call, Visit and the combined history", () => {
  test("a Telecaller logs a call: who, when, outcome, notes, follow-up — never counted as Call 1/2/3", async () => {
    const leadId = await raise("Call Me");
    for (let i = 0; i < 4; i++) {
      const r = await logLeadCall({
        customerId: leadId,
        clientKey: key(),
        outcome: i === 0 ? "callback" : "no_answer",
        notes: "wants rates",
        followUpDate: i === 0 ? tomorrow : undefined,
      });
      assert.ok(r.ok, r.ok ? "" : r.error);
    }
    const [c] = await db.select().from(calls).where(and(eq(calls.customerId, leadId), eq(calls.notes, "wants rates"))).limit(1);
    assert.equal(c.userId, teleA.id);
    assert.equal((c.outcomeDetail as Record<string, string>).activity, "general_call");
    /* the qualification rule is intact: the first qualification call is still Call 1 */
    const q = await logQualificationCall({ customerId: leadId, outcome: "spoke_callback", answers: {} });
    assert.ok(q.ok, q.ok ? "" : q.error);
    const [first] = await db.execute(
      sql`select outcome_detail->>'qualCall' as n from calls where customer_id = ${leadId} and outcome_detail->>'qualCall' is not null`,
    );
    assert.equal((first as { n: string }).n, "1");
  });

  test("a Sales Manager and a Telecaller each log a visit on their own lead — marked as not location-checked", async () => {
    const mine = await raise("Tele Visit");
    assert.ok((await logLeadVisit({ customerId: mine, clientKey: key(), outcome: "visited", notes: "met the owner", followUpDate: tomorrow })).ok);
    setTestUser(seema);
    const hers = await raise("Seema Visit");
    assert.ok((await logLeadVisit({ customerId: hers, clientKey: key(), outcome: "sample" })).ok);
    const [v] = await db.select().from(mbosVisits).where(eq(mbosVisits.customerId, mine));
    assert.equal(v.salesmanId, teleA.id);
    assert.equal(v.deviceId, null);
    assert.equal(v.verified, false);
    assert.match(v.unverifiedReason ?? "", /by hand/);
  });

  test("a visit is recorded for a named salesman — his name, the discussion, notes and follow-up — and who entered it is kept apart", async () => {
    setTestUser(seema);
    const leadId = await raise("Salesman Visit");
    const otherSalesman = await makeUser("Salesman Other", "associate", "field");

    /* Not on her team yet: refused on the server, whatever the dropdown offered. */
    const offTeam = await logLeadVisit({ customerId: leadId, clientKey: key(), outcome: "visited", salesmanId: salesman.id });
    assert.equal(offTeam.ok, false, "a salesman who is not on her team cannot be named");
    assert.equal((await db.select().from(mbosVisits).where(eq(mbosVisits.customerId, leadId))).length, 0, "nothing was written");
    const beforeList = await visitSalesmenAction(leadId);
    assert.ok(beforeList.ok);
    assert.deepEqual(beforeList.data.people.map((p) => p.id), [seema.id], "the dropdown offers only herself");

    /* He reports to her: now he is on the team. */
    await db.update(users).set({ reportsToId: seema.id }).where(eq(users.id, salesman.id));
    const r = await logLeadVisit({
      customerId: leadId,
      clientKey: key(),
      outcome: "order",
      discussion: "Rates for PU thinner",
      notes: "Wants delivery by Friday",
      salesmanId: salesman.id,
      followUpDate: tomorrow,
    });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const [v] = await db.select().from(mbosVisits).where(eq(mbosVisits.customerId, leadId));
    assert.equal(v.salesmanId, salesman.id, "the visit is the salesman's");
    assert.equal(v.createdById, seema.id, "…and the person who entered it is on the row");
    assert.match(v.notes ?? "", /Discussed: Rates for PU thinner/);
    assert.match(v.notes ?? "", /Notes: Wants delivery by Friday/);
    assert.equal(v.nextFollowUpDate, tomorrow);
    assert.equal(v.deviceId, null, "no handset, no location, no check-in");
    assert.equal(v.checkOutAt, null, "no check-out or duration");
    assert.equal(v.durationSeconds, null);
    const h = await leadActivityHistoryAction(leadId);
    assert.ok(h.ok, h.ok ? "" : h.error);
    const visit = h.data.find((a) => a.type === "visit");
    assert.equal(visit?.byName, "Salesman S");
    assert.match(visit?.note ?? "", /Entered by Seema Roy/);

    const notSalesman = await logLeadVisit({ customerId: leadId, clientKey: key(), outcome: "visited", salesmanId: teleB.id });
    assert.equal(notSalesman.ok, false, "only a salesman on her team can be named");
    const stillOff = await logLeadVisit({ customerId: leadId, clientKey: key(), outcome: "visited", salesmanId: otherSalesman.id });
    assert.equal(stillOff.ok, false, "a salesman nobody connects to her is still refused");

    const list = await visitSalesmenAction(leadId);
    assert.ok(list.ok);
    assert.deepEqual(list.data.people.map((p) => p.id).sort(), [seema.id, salesman.id].sort(), "the dropdown offers her and her team only");

    /* A salesman who works a book under her Sales Manager seat is on her team too. */
    await db.insert(customers).values({
      id: id("cus"), name: "Seated Shop", phone: "9150000009", city: "Pune",
      kind: "customer", ownerId: otherSalesman.id, salesManagerId: seema.id,
    } as never);
    const viaSeat = await logLeadVisit({ customerId: leadId, clientKey: key(), outcome: "visited", salesmanId: otherSalesman.id });
    assert.ok(viaSeat.ok, viaSeat.ok ? "" : viaSeat.error);

    /* An administrator manages every salesman. */
    setTestUser(boss);
    const adminList = await visitSalesmenAction(leadId);
    assert.ok(adminList.ok);
    assert.ok([salesman.id, otherSalesman.id].every((id2) => adminList.data.people.some((p) => p.id === id2)));
  });

  test("the same dialog sent twice is one record, and the future is refused", async () => {
    const leadId = await raise("Once");
    const k = key();
    await logLeadVisit({ customerId: leadId, clientKey: k, outcome: "visited" });
    await logLeadVisit({ customerId: leadId, clientKey: k, outcome: "visited" });
    assert.equal((await db.select().from(mbosVisits).where(eq(mbosVisits.customerId, leadId))).length, 1);
    const future = await logLeadCall({ customerId: leadId, clientKey: key(), outcome: "spoke", onDate: addDays((await today()) as BusinessDate, 3) });
    assert.equal(future.ok, false);
  });

  test("calls and visits interleave newest first with who did each; a handset visit is told apart", async () => {
    const leadId = await raise("History");
    const at = (ms: number) => new Date(Date.now() - ms);
    await db.insert(calls).values({
      id: id("cal"), customerId: leadId, userId: teleA.id, direction: "outbound", interactionType: "outbound_call",
      outcome: "no_answer", startedAt: at(4 * 3_600_000), notes: "rang twice", sourceModule: "customer_record",
      outcomeDetail: { activity: "general_call", generalOutcome: "no_answer" }, idempotencyKey: id("k"),
    });
    await db.insert(mbosVisits).values({
      id: id("vis"), customerId: leadId, salesmanId: teleA.id, deviceId: "d", checkInAt: at(3 * 3_600_000), outcome: "visited", notes: "shop open",
    });
    await logLeadVisit({ customerId: leadId, clientKey: key(), outcome: "visited" });
    const h = await leadActivityHistoryAction(leadId);
    assert.ok(h.ok, h.ok ? "" : h.error);
    assert.deepEqual(h.data.map((a) => a.type), ["visit", "visit", "call"]);
    assert.deepEqual(h.data.filter((a) => a.type === "visit").map((a) => a.source).sort(), ["handset", "web"]);
    assert.ok(h.data.every((a, i, all) => i === 0 || Date.parse(all[i - 1].at) >= Date.parse(a.at)));
  });

  test("nobody logs on, or reads the history of, a lead outside their book; row flags follow", async () => {
    const leadId = await raise("Telecaller A's lead");
    setTestUser(teleB);
    assert.equal((await logLeadCall({ customerId: leadId, clientKey: key(), outcome: "spoke" })).ok, false);
    assert.equal((await logLeadVisit({ customerId: leadId, clientKey: key(), outcome: "visited" })).ok, false);
    assert.equal((await leadActivityHistoryAction(leadId)).ok, false);
    assert.deepEqual(await workableLeadIds([leadId], teleB.id), []);
    setTestUser(teleA);
    assert.deepEqual(await workableLeadIds([leadId], teleA.id), [leadId]);
    assert.equal((await db.select().from(calls).where(eq(calls.customerId, leadId))).length, 0);
  });
});

describe("C — Option B: reassigning from the Leads Page", () => {
  test("a Sales Manager (associate level) hands her own lead to somebody — and nobody else's", async () => {
    setTestUser(seema);
    const hers = await raise("Hers To Move");
    setTestUser(teleA);
    const theirs = await raise("Not Hers");
    setTestUser(seema);

    const refused = await reassignLead({ leadId: theirs, salesmanId: salesman.id });
    assert.equal(refused.ok, false, "a lead outside her own book is refused");
    assert.equal((await row(theirs)).ownerId, teleA.id);

    const moved = await reassignLead({ leadId: hers, salesmanId: salesman.id });
    assert.ok(moved.ok, moved.ok ? "" : moved.error);
    assert.equal((await row(hers)).ownerId, salesman.id);
    const [made] = await db
      .select()
      .from(timelineEvents)
      .where(and(eq(timelineEvents.customerId, hers), eq(timelineEvents.eventType, "lead_created")));
    assert.equal(made.actorUserId, seema.id, "the creator is untouched by the move");
  });

  test("a Telecaller cannot reassign through it", async () => {
    const leadId = await raise("Telecaller's own");
    const r = await reassignLead({ leadId, salesmanId: salesman.id });
    assert.equal(r.ok, false);
    assert.equal((await row(leadId)).ownerId, teleA.id);
  });
});
