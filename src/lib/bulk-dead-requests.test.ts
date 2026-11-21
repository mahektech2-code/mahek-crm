/**
 * MARK SEVERAL LOST LEADS AS DEAD — every selected lead goes for approval.
 *
 *   A  All fifteen go: one request each, same approver, owners untouched
 *   B  ONE bell message for the batch; the single door still sends its own
 *   C  A mixed selection: the eligible go, the rest are named with the reason
 *   D  Settled once, up front: bad reason, missing note, no approver, empty, too many
 *   E  Each request is decided on its own
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  auditLog,
  customers,
  employeeReporting,
  employees,
  leadDeadRequests,
  notifications,
  timelineEvents,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { BULK_DEAD_MAX } from "@/lib/lead-dead";
import { decideDeadRequest, requestDeadLead, requestDeadLeads } from "@/lib/actions/lead-dead";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type U = typeof users.$inferSelect;

let requester: U;
let manager: U;
let otherManager: U;
let loner: U; // reports to nobody on the Org Chart

async function emp(name: string) {
  const [e] = await db
    .insert(employees)
    .values({
      id: id("emp"),
      rowNumber: Math.floor(Math.random() * 100000),
      employeeCode: `EMP-${randomUUID().slice(0, 6)}`,
      name,
      status: "active",
      raw: {},
      rowHash: randomUUID(),
    })
    .returning();
  return e!;
}

async function person(name: string, role: "associate" | "manager", employeeId: string | null) {
  const [u] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
      employeeId,
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u!.id, app: "crm", role });
  return u!;
}

async function lead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [c] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nashik",
      kind: "lead",
      leadStage: "lost",
      leadLostReason: "price",
      leadSalesType: "direct",
      ownerId: requester.id,
      leadManagerId: manager.id,
      ...over,
    })
    .returning();
  return c!;
}

const requestsOf = (leadId: string) => db.select().from(leadDeadRequests).where(eq(leadDeadRequests.customerId, leadId));
const reload = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0]!;
const bell = (userId: string) => db.select().from(notifications).where(eq(notifications.userId, userId));
const bulk = (ids: string[], over: Partial<Parameters<typeof requestDeadLeads>[0]> = {}) =>
  requestDeadLeads({ customerIds: ids, reasonCode: "no_response", ...over });

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against a test database only.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_dead_requests, lead_stage_transitions, notifications, timeline_events, audit_log,
      app_module_access, app_access, employee_reporting, customers, employees, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  const [eReq, eMgr] = [await emp("Rina Requester"), await emp("Manoj Manager")];
  manager = await person("Manoj Manager", "manager", eMgr.id);
  requester = await person("Rina Requester", "associate", eReq.id);
  otherManager = await person("Olga Other", "manager", null);
  loner = await person("Lena Loner", "associate", (await emp("Lena Loner")).id);
  await db.insert(employeeReporting).values({ id: id("rep"), employeeId: eReq.id, managerId: eMgr.id });
  setTestUser(requester);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("A · all of them go", () => {
  test("fifteen selected Lost leads become fifteen requests to the same manager; owners and stage untouched", async () => {
    const leads = await Promise.all(Array.from({ length: 15 }, () => lead()));
    const r = await bulk(leads.map((l) => l.id));
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal(r.ok && r.data.requested, 15);
    assert.deepEqual(r.ok && r.data.refused, []);
    assert.equal(r.ok && r.data.approverName, "Manoj Manager");

    for (const l of leads) {
      const reqs = await requestsOf(l.id);
      assert.equal(reqs.length, 1, "one request per lead");
      assert.equal(reqs[0]!.state, "pending");
      assert.equal(reqs[0]!.approverId, manager.id, "the same approver for the whole batch");
      assert.equal(reqs[0]!.requestedById, requester.id);
      const row = await reload(l.id);
      assert.equal(row.ownerId, requester.id, "owner untouched");
      assert.equal(row.leadStage, "lost", "still Lost until the manager decides");
      const audit = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, l.id), eq(auditLog.action, "lead.dead.request")));
      assert.equal(audit.length, 1, "its own audit row");
      assert.equal(audit[0]!.actorId, requester.id);
      const tl = await db.select().from(timelineEvents).where(eq(timelineEvents.customerId, l.id));
      assert.ok(tl.some((t) => /Marked Dead requested/.test(t.summary ?? "")), "its own timeline entry");
    }
  });

  test("the same lead twice in one selection is one request", async () => {
    const l = await lead();
    const r = await bulk([l.id, l.id]);
    assert.equal(r.ok && r.data.requested, 1);
    assert.equal((await requestsOf(l.id)).length, 1);
  });

  test("sending the same selection again raises nothing new and names every lead", async () => {
    const leads = await Promise.all(Array.from({ length: 3 }, () => lead()));
    await bulk(leads.map((l) => l.id));
    const again = await bulk(leads.map((l) => l.id));
    assert.equal(again.ok && again.data.requested, 0);
    assert.equal(again.ok && again.data.refused.length, 3);
    assert.match(again.ok ? again.data.refused[0]!.why : "", /already waiting|already/i);
    for (const l of leads) assert.equal((await requestsOf(l.id)).length, 1);
  });
});

describe("B · one bell message for the batch", () => {
  test("the manager gets one summary, not fifteen", async () => {
    const leads = await Promise.all(Array.from({ length: 15 }, () => lead()));
    await bulk(leads.map((l) => l.id));
    const told = await bell(manager.id);
    assert.equal(told.length, 1);
    assert.match(told[0]!.title, /15 Dead requests from Rina Requester/);
    assert.equal(told[0]!.kind, "warn");
  });

  test("the single door is unchanged: one lead, one message of its own", async () => {
    const l = await lead();
    const r = await requestDeadLead({ customerId: l.id, reasonCode: "no_response" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const told = await bell(manager.id);
    assert.equal(told.length, 1);
    assert.match(told[0]!.title, /^Dead request: /);
  });

  test("nothing sent, nobody rung", async () => {
    const notLost = await lead({ leadStage: "suspect", leadLostReason: null });
    const r = await bulk([notLost.id]);
    assert.equal(r.ok && r.data.requested, 0);
    assert.equal((await bell(manager.id)).length, 0);
  });
});

describe("C · a mixed selection", () => {
  test("the eligible go; the rest are named with the sentence the single action gives", async () => {
    const good1 = await lead({ name: "Good One" });
    const good2 = await lead({ name: "Good Two" });
    const notLost = await lead({ name: "Still Working", leadStage: "prospect", leadLostReason: null });
    const pendingAlready = await lead({ name: "Already Asked" });
    await requestDeadLead({ customerId: pendingAlready.id, reasonCode: "no_response" });
    const outOfReach = await lead({ name: "Not Mine", ownerId: otherManager.id, leadManagerId: otherManager.id });

    const r = await bulk([good1.id, notLost.id, good2.id, pendingAlready.id, outOfReach.id]);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal(r.ok && r.data.requested, 2);
    const refused = r.ok ? r.data.refused : [];
    assert.deepEqual(refused.map((f) => f.name).sort(), ["Already Asked", "Not Mine", "Still Working"]);
    assert.match(refused.find((f) => f.name === "Still Working")!.why, /only a lead that is already Lost/i);
    assert.equal((await requestsOf(good1.id)).length, 1);
    assert.equal((await requestsOf(good2.id)).length, 1);
    assert.equal((await requestsOf(notLost.id)).length, 0);
    assert.equal((await requestsOf(outOfReach.id)).length, 0);
    assert.equal((await requestsOf(pendingAlready.id)).length, 1, "no second request on a pending lead");
  });

  test("a lead that does not exist is named, not fatal", async () => {
    const good = await lead();
    const r = await bulk(["cus_does_not_exist", good.id]);
    assert.equal(r.ok && r.data.requested, 1);
    assert.equal(r.ok && r.data.refused.length, 1);
  });
});

describe("D · settled once, up front", () => {
  test("a reason that is not on the list sends nothing", async () => {
    const l = await lead();
    const r = await bulk([l.id], { reasonCode: "made-up" });
    assert.equal(r.ok, false);
    assert.equal((await requestsOf(l.id)).length, 0);
  });

  test("Other needs words, once", async () => {
    const l = await lead();
    const r = await bulk([l.id], { reasonCode: "other" });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /say in words/i);
    assert.equal((await requestsOf(l.id)).length, 0);
    const ok = await bulk([l.id], { reasonCode: "other", note: "Shop demolished" });
    assert.equal(ok.ok && ok.data.requested, 1);
  });

  test("an Org Chart that cannot name an approver is said once and nothing is sent", async () => {
    const mine = await lead({ ownerId: loner.id, leadManagerId: loner.id });
    setTestUser(loner);
    const r = await bulk([mine.id]);
    assert.equal(r.ok, false);
    assert.equal((await requestsOf(mine.id)).length, 0);
  });

  test("an empty selection and an oversized one are refused", async () => {
    assert.equal((await bulk([])).ok, false);
    const ids = Array.from({ length: BULK_DEAD_MAX + 1 }, (_, i) => `cus_x_${i}`);
    const r = await bulk(ids);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /At most/);
  });
});

describe("E · each request is decided on its own", () => {
  test("the manager approves one and rejects another; the rest stay waiting", async () => {
    const [a, b, c] = await Promise.all([lead(), lead(), lead()]);
    await bulk([a.id, b.id, c.id]);
    const [ra, rb] = [(await requestsOf(a.id))[0]!, (await requestsOf(b.id))[0]!];
    setTestUser(manager);
    const approved = await decideDeadRequest({ requestId: ra.id, approve: true, confirmed: true });
    assert.equal(approved.ok, true, approved.ok ? "" : approved.error);
    const rejected = await decideDeadRequest({ requestId: rb.id, approve: false, note: "Still worth a call." });
    assert.equal(rejected.ok, true, rejected.ok ? "" : rejected.error);

    assert.ok((await reload(a.id)).leadDeadAt, "A is Dead");
    assert.equal((await reload(b.id)).leadDeadAt, null, "B is not");
    assert.equal((await requestsOf(c.id))[0]!.state, "pending", "C is still waiting");
  });
});
