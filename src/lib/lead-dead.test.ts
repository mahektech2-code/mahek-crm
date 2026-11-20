/**
 * Dead Leads — a Lost lead made PERMANENTLY dead, by its requester's reporting
 * manager, and read-only for ever after.
 *
 *   A  Eligibility is enforced on the server, not only drawn in a menu
 *   B  The approver is the Org Chart manager — and a request that cannot be
 *      routed is refused, never sent to somebody else
 *   C  One pending request per lead; reverse is blocked while one is pending
 *   D  Only the assigned manager decides; rejection needs a reason and leaves
 *      the lead alone; a rejected lead can be asked about again
 *   E  Approval: Dead is a marker on a Lost lead, history is kept
 *   F  Permanence — the database, the server actions and the handset sync
 *   G  Background jobs do not trip over a Dead lead
 *   H  Normal Lost leads keep working; the Lost list and Dead list read right
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  auditLog,
  calls,
  customers,
  employeeReporting,
  employees,
  leadDeadRequests,
  leadStageTransitions,
  mbosTasks,
  notifications,
  orders,
  timelineEvents,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { advanceLeadStage } from "@/lib/actions/leads";
import { decideDeadRequest, requestDeadLead, requestDeadLeads, previewDeadApprover, withdrawDeadRequest } from "@/lib/actions/lead-dead";
import { reopenSalesManagerLead } from "@/lib/actions/lead-reopen";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { ageLeads, mbosHourly, mbosNightly, raiseNurtureTasks } from "@/lib/mbos-jobs";
import { runHourly, runNightly } from "@/lib/jobs";
import { recomputeInactivity, recomputeOutstanding } from "@/lib/recompute";
import { deadLeadsPage, deadQueueFor, deadRequestsOfLead } from "@/lib/services/lead-dead-service";
import { lostLeadsPage } from "@/lib/services/lead-lost-service";
import type { MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

type User = typeof users.$inferSelect;

async function makeEmployee(name: string, status: "active" | "inactive" = "active") {
  const [row] = await db
    .insert(employees)
    .values({
      id: id("emp"),
      rowNumber: Math.floor(Math.random() * 100000),
      employeeCode: `EMP-${randomUUID().slice(0, 6)}`,
      name,
      status: status === "active" ? "active" : "inactive",
      raw: {},
      rowHash: randomUUID(),
    })
    .returning();
  return row;
}

async function makeUser(
  name: string,
  role: "associate" | "manager" | "admin",
  over: { employeeId?: string | null; active?: boolean; crm?: boolean } = {},
): Promise<User> {
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
      employeeId: over.employeeId ?? null,
      active: over.active ?? true,
    })
    .returning();
  if (over.crm !== false) {
    await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role });
  }
  return row;
}

let reqEmp: typeof employees.$inferSelect;
let mgrEmp: typeof employees.$inferSelect;
let requester: User;
let manager: User;
let otherManager: User;
let admin: User;

async function makeLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
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
  return row;
}

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const requestsOf = (leadId: string) =>
  db.select().from(leadDeadRequests).where(eq(leadDeadRequests.customerId, leadId)).orderBy(leadDeadRequests.requestedAt);

const ask = (leadId: string, over: Partial<Parameters<typeof requestDeadLead>[0]> = {}) =>
  requestDeadLead({ customerId: leadId, reasonCode: "no_response", ...over });

async function approve(leadId: string) {
  const [req] = await requestsOf(leadId);
  setTestUser(manager);
  const r = await decideDeadRequest({ requestId: req.id, approve: true, confirmed: true });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  return req;
}

/** A lead that is already Dead, made the proper way round. */
async function deadLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const lead = await makeLead(over);
  setTestUser(requester);
  const r = await ask(lead.id);
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  await approve(lead.id);
  return lead;
}

async function dbError(fn: () => Promise<unknown>): Promise<{ code?: string }> {
  try {
    await fn();
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause ?? (e as { code?: string });
    return { code: cause?.code };
  }
  return {};
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
    truncate table lead_dead_requests, lead_stage_transitions, mbos_tasks, calls, orders, notifications,
      timeline_events, audit_log, app_module_access, app_access, employee_reporting, customers, employees,
      users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  reqEmp = await makeEmployee("Rina Requester");
  mgrEmp = await makeEmployee("Manoj Manager");
  manager = await makeUser("Manoj Manager", "manager", { employeeId: mgrEmp.id });
  requester = await makeUser("Rina Requester", "associate", { employeeId: reqEmp.id });
  otherManager = await makeUser("Olga Other", "manager");
  admin = await makeUser("Ada Admin", "admin");
  // The Lost and Dead lists are read through the Sales Dashboard's manager scope, which needs the grant.
  await db.insert(appAccess).values({ id: id("aca"), userId: admin.id, app: "sales", role: "admin" });
  await db.insert(employeeReporting).values({ id: id("rep"), employeeId: reqEmp.id, managerId: mgrEmp.id });
  setTestUser(requester);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("A — eligibility is enforced on the server", () => {
  test("a lead that is not Lost cannot be asked about, whatever the menu drew", async () => {
    for (const stage of ["suspect", "prospect", "negotiation", "on_hold"] as const) {
      const lead = await makeLead({ leadStage: stage, leadLostReason: null });
      const r = await ask(lead.id);
      assert.equal(r.ok, false, stage);
      assert.match(!r.ok ? r.error : "", /only a lead that is already Lost/i);
      assert.equal((await requestsOf(lead.id)).length, 0);
    }
  });

  test("a reason from the configured list is required, and Other needs words", async () => {
    const lead = await makeLead();
    assert.equal((await ask(lead.id, { reasonCode: "made-up" })).ok, false);
    const other = await ask(lead.id, { reasonCode: "other" });
    assert.equal(other.ok, false);
    assert.match(!other.ok ? other.error : "", /say in words/i);
    assert.equal((await ask(lead.id, { reasonCode: "other", note: "Shop demolished" })).ok, true);
  });

  test("somebody who cannot see the lead cannot ask about it", async () => {
    const lead = await makeLead({ ownerId: otherManager.id, leadManagerId: otherManager.id });
    const stranger = await makeUser("Sam Stranger", "associate", { employeeId: (await makeEmployee("Sam")).id });
    await db.insert(employeeReporting).values({ id: id("rep"), employeeId: stranger.employeeId!, managerId: mgrEmp.id });
    setTestUser(stranger);
    const r = await ask(lead.id);
    assert.equal(r.ok, false);
    assert.equal((await requestsOf(lead.id)).length, 0);
  });
});

/**
 * Runs `fn` as if the request came from the CRM — the app the proxy names from
 * the URL. A lead action reads it (`requestAppId`) to decide whose lead list to
 * ask, and a test has no request, so the header is supplied here and put back.
 */
async function inCrm<T>(fn: () => Promise<T>): Promise<T> {
  const nextHeaders = createRequire(`${process.cwd()}/package.json`)("next/headers") as { headers: unknown };
  const original = nextHeaders.headers;
  Object.defineProperty(nextHeaders, "headers", {
    value: async () => new Headers({ "x-mahek-app": "crm" }),
    configurable: true,
    writable: true,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(nextHeaders, "headers", { value: original, configurable: true, writable: true });
  }
}

describe("A2 — a lead on the requester's list through her team is one she may ask about", () => {
  /* The reported case: the lead is Lost and owned by a salesman who reports to
     the Sales Manager. She sees it on /crm/leads through her team, and the
     request used to be refused with "customer.read requires the associate
     level" because the action asked the CRM's narrower scope, not the list's. */
  async function salesManagerWithTeamLead() {
    const seemaEmp = await makeEmployee("Seema Roy");
    const seema = await makeUser("Seema Roy", "associate", { employeeId: seemaEmp.id });
    // Her grant is the Sales Manager module, not a manager LEVEL.
    for (const key of ["crm.leads", "crm.sales-manager"]) {
      await db.insert(appModuleAccess).values({ id: id("ama"), userId: seema.id, app: "crm", module: key });
    }
    await db.insert(employeeReporting).values({ id: id("rep"), employeeId: seemaEmp.id, managerId: mgrEmp.id });
    const prakash = await makeUser("Prakash Prasad", "associate");
    await db.update(users).set({ reportsToId: seema.id }).where(eq(users.id, prakash.id));
    // No seat names Seema: the team arm is the ONLY way this lead is hers.
    const lead = await makeLead({ ownerId: prakash.id, leadManagerId: null, salesManagerId: null });
    return { seema, prakash, lead };
  }

  test("the Sales Manager can ask for Dead on a Lost lead owned by her reporting-team salesman", async () => {
    const { seema, lead } = await salesManagerWithTeamLead();
    setTestUser(seema);
    const r = await inCrm(() => ask(lead.id, { note: "Customer said never to call again" }));
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const [req] = await requestsOf(lead.id);
    assert.equal(req.requestedById, seema.id);
    assert.equal(req.approverId, manager.id, "still routed to her Org Chart manager, nobody else");
    assert.equal(req.state, "pending");
  });

  test("the same holds for several at once: her team's leads go, a stranger's lead is named as refused", async () => {
    const { seema, lead } = await salesManagerWithTeamLead();
    const foreign = await makeLead({ ownerId: otherManager.id, leadManagerId: otherManager.id, salesManagerId: null });
    setTestUser(seema);
    const r = await inCrm(() => requestDeadLeads({ customerIds: [lead.id, foreign.id], reasonCode: "no_response" }));
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal(r.ok && r.data.requested, 1);
    assert.deepEqual(r.ok ? r.data.refused.map((x) => x.id) : [], [foreign.id]);
    assert.equal((await requestsOf(lead.id)).length, 1);
    assert.equal((await requestsOf(foreign.id)).length, 0);
  });

  test("an unrelated associate still cannot ask about that lead", async () => {
    const { lead } = await salesManagerWithTeamLead();
    const stranger = await makeUser("Sam Stranger", "associate", { employeeId: (await makeEmployee("Sam")).id });
    await db.insert(employeeReporting).values({ id: id("rep"), employeeId: stranger.employeeId!, managerId: mgrEmp.id });
    setTestUser(stranger);
    const r = await inCrm(() => ask(lead.id));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /customer\.read/);
    assert.equal((await requestsOf(lead.id)).length, 0, "nothing was written");
  });
});

describe("B — the approver is the Org Chart manager, and nobody else", () => {
  test("the request goes to the reporting manager only, and is stored with them", async () => {
    const lead = await makeLead();
    const preview = await previewDeadApprover();
    assert.equal(preview.ok && preview.data.approverName, "Manoj Manager");
    const r = await ask(lead.id, { note: "Tried eleven times" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const [req] = await requestsOf(lead.id);
    assert.equal(req.approverId, manager.id);
    assert.equal(req.approverEmployeeId, mgrEmp.id);
    assert.equal(req.requesterEmployeeId, reqEmp.id);
    assert.equal(req.state, "pending");

    const bells = await db.select().from(notifications);
    assert.equal(bells.length, 1, "exactly one bell");
    assert.equal(bells[0].userId, manager.id);
    assert.ok(!bells.some((b) => b.userId === otherManager.id || b.userId === admin.id), "nobody else is told");

    assert.equal((await deadQueueFor(manager.id)).length, 1);
    assert.equal((await deadQueueFor(otherManager.id)).length, 0);

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "lead.dead.request"));
    assert.equal(audits.length, 1);
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.customerId, lead.id));
    assert.ok(events.some((e) => e.eventType === "lead_dead" && e.sourceRecordId?.endsWith(":requested")));
  });

  const refused = async (why: RegExp, setup: () => Promise<void>) => {
    await setup();
    const lead = await makeLead();
    const r = await ask(lead.id);
    assert.equal(r.ok, false, "refused");
    assert.match(!r.ok ? r.error : "", why);
    assert.match(!r.ok ? r.error : "", /administrator has to correct the Org Chart/i);
    assert.equal((await requestsOf(lead.id)).length, 0, "nothing was written");
    assert.equal((await db.select().from(notifications)).length, 0, "nobody was told, not even somebody else");
    assert.equal((await row(lead.id)).leadDeadAt, null);
  };

  test("no Org Chart link at all is refused", () =>
    refused(/no reporting manager/i, async () => {
      await db.delete(employeeReporting);
    }));

  test("an account not linked to an employee is refused", () =>
    refused(/not linked to an employee/i, async () => {
      await db.update(users).set({ employeeId: null }).where(eq(users.id, requester.id));
    }));

  test("an inactive manager is refused — the request is NOT routed to somebody else", () =>
    refused(/no longer active/i, async () => {
      await db.update(employees).set({ status: "inactive" }).where(eq(employees.id, mgrEmp.id));
    }));

  test("a manager with no MahekOne account is refused", () =>
    refused(/no MahekOne account/i, async () => {
      await db.update(users).set({ employeeId: null }).where(eq(users.id, manager.id));
    }));

  test("a disabled manager account is refused", () =>
    refused(/disabled/i, async () => {
      await db.update(users).set({ active: false }).where(eq(users.id, manager.id));
    }));

  test("a manager who reports to themselves cannot approve their own request", async () => {
    await db.update(employeeReporting).set({ managerId: reqEmp.id }).where(eq(employeeReporting.employeeId, reqEmp.id));
    const lead = await makeLead();
    const r = await ask(lead.id);
    assert.equal(r.ok, false);
    assert.equal((await requestsOf(lead.id)).length, 0);
  });
});

describe("C — one pending request per lead, and reverse waits for it", () => {
  test("a second request for the same lead is refused", async () => {
    const lead = await makeLead();
    assert.equal((await ask(lead.id)).ok, true);
    const again = await ask(lead.id);
    assert.equal(again.ok, false);
    assert.match(!again.ok ? again.error : "", /already waiting/i);
    assert.equal((await requestsOf(lead.id)).length, 1);
  });

  test("two simultaneous requests make exactly one", async () => {
    const lead = await makeLead();
    const [a, b] = await Promise.all([ask(lead.id), ask(lead.id)]);
    assert.equal([a, b].filter((r) => r.ok).length, 1);
    assert.equal((await requestsOf(lead.id)).length, 1);
  });

  test("the database itself refuses a second pending row", async () => {
    const lead = await makeLead();
    assert.equal((await ask(lead.id)).ok, true);
    const [first] = await requestsOf(lead.id);
    const e = await dbError(() =>
      db.insert(leadDeadRequests).values({
        id: id("ldr"),
        customerId: lead.id,
        requestedById: requester.id,
        reasonCode: "no_response",
        approverId: manager.id,
        lostReasonAtRequest: first.lostReasonAtRequest,
      }),
    );
    assert.equal(e.code, "23505");
  });

  test("Reverse Lost is blocked while a request is pending — in the action and in the database", async () => {
    const lead = await makeLead();
    assert.equal((await ask(lead.id)).ok, true);

    setTestUser(manager);
    const r = await reopenSalesManagerLead({ customerId: lead.id, reasonCode: "customer_responded" });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /waiting on its manager/i);
    assert.equal((await row(lead.id)).leadStage, "lost");

    const e = await dbError(() => db.update(customers).set({ leadStage: "contacted" }).where(eq(customers.id, lead.id)));
    assert.equal(e.code, "DL002");
  });
});

describe("D — only the assigned manager decides", () => {
  test("another manager, an administrator and the requester are all refused", async () => {
    const lead = await makeLead();
    assert.equal((await ask(lead.id)).ok, true);
    const [req] = await requestsOf(lead.id);

    for (const who of [otherManager, admin, requester]) {
      setTestUser(who);
      const r = await decideDeadRequest({ requestId: req.id, approve: true, confirmed: true });
      assert.equal(r.ok, false, who.name);
    }
    assert.equal((await row(lead.id)).leadDeadAt, null);
    assert.equal((await requestsOf(lead.id))[0].state, "pending");
  });

  test("approving needs an explicit confirmation", async () => {
    const lead = await makeLead();
    assert.equal((await ask(lead.id)).ok, true);
    const [req] = await requestsOf(lead.id);
    setTestUser(manager);
    const r = await decideDeadRequest({ requestId: req.id, approve: true });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadDeadAt, null);
  });

  test("a rejection needs a reason, leaves the lead untouched, and is kept in the history", async () => {
    const lead = await makeLead();
    assert.equal((await ask(lead.id)).ok, true);
    const [req] = await requestsOf(lead.id);
    const before = await row(lead.id);

    setTestUser(manager);
    assert.equal((await decideDeadRequest({ requestId: req.id, approve: false })).ok, false);

    const r = await decideDeadRequest({ requestId: req.id, approve: false, note: "Still worth one call" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const after = await row(lead.id);
    assert.equal(after.leadDeadAt, null);
    assert.equal(after.leadStage, "lost");
    assert.equal(after.leadLostReason, before.leadLostReason);
    assert.equal(after.ownerId, before.ownerId);

    const [kept] = await requestsOf(lead.id);
    assert.equal(kept.state, "rejected");
    assert.equal(kept.decidedById, manager.id);
    assert.equal(kept.decisionNote, "Still worth one call");

    const toRequester = await db.select().from(notifications).where(eq(notifications.userId, requester.id));
    assert.equal(toRequester.length, 1);
    assert.match(toRequester[0].body, /Still worth one call/);

    // …and a decided request is history: it cannot be decided again.
    const twice = await decideDeadRequest({ requestId: req.id, approve: true, confirmed: true });
    assert.equal(twice.ok, false);
  });

  test("after a rejection the employee can send a fresh request", async () => {
    const lead = await makeLead();
    assert.equal((await ask(lead.id)).ok, true);
    const [req] = await requestsOf(lead.id);
    setTestUser(manager);
    assert.equal((await decideDeadRequest({ requestId: req.id, approve: false, note: "No" })).ok, true);

    setTestUser(requester);
    assert.equal((await ask(lead.id, { note: "Second try" })).ok, true);
    const all = await requestsOf(lead.id);
    assert.deepEqual(all.map((r) => r.state), ["rejected", "pending"]);
    assert.equal((await deadRequestsOfLead(lead.id)).length, 2);
  });

  test("the database refuses a decision by anybody but the stored approver", async () => {
    const lead = await makeLead();
    assert.equal((await ask(lead.id)).ok, true);
    const e = await dbError(() =>
      db
        .update(leadDeadRequests)
        .set({ state: "approved", decidedById: otherManager.id, decidedAt: new Date() })
        .where(eq(leadDeadRequests.customerId, lead.id)),
    );
    assert.equal(e.code, "23514");
  });
});

describe("E — approval makes a Lost lead permanently Dead", () => {
  test("Dead is a marker on a Lost lead — the stage does not change and history stays", async () => {
    const lead = await makeLead();
    await db.insert(calls).values({
      id: id("cal"),
      customerId: lead.id,
      userId: requester.id,
      outcome: "no_answer",
      startedAt: new Date(),
      notes: "rang, nobody",
    } as never);
    setTestUser(requester);
    assert.equal((await ask(lead.id)).ok, true);
    await approve(lead.id);

    const after = await row(lead.id);
    assert.ok(after.leadDeadAt, "dead marker set");
    assert.equal(after.leadDeadById, manager.id);
    assert.equal(after.leadStage, "lost", "still Lost, so every Lost count reads as before");
    assert.equal(after.leadLostReason, "price");

    // History is untouched and still readable.
    assert.equal((await db.select().from(calls).where(eq(calls.customerId, lead.id))).length, 1);
    const [req] = await requestsOf(lead.id);
    assert.equal(req.state, "approved");

    const toRequester = await db.select().from(notifications).where(eq(notifications.userId, requester.id));
    assert.equal(toRequester.length, 1);
    const approvals = await db.select().from(auditLog).where(eq(auditLog.action, "lead.dead.approve"));
    assert.equal(approvals.length, 1);
  });

  test("a request about an already Dead lead is refused", async () => {
    const lead = await deadLead();
    setTestUser(requester);
    const r = await ask(lead.id);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /already permanently Dead/i);
  });
});

describe("F — a Dead lead is read-only for ever", () => {
  test("the database refuses every business change, the delete, and un-dying", async () => {
    const lead = await deadLead();
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["stage", () => db.update(customers).set({ leadStage: "contacted" }).where(eq(customers.id, lead.id))],
      ["kind", () => db.update(customers).set({ kind: "customer" }).where(eq(customers.id, lead.id))],
      ["owner", () => db.update(customers).set({ ownerId: otherManager.id }).where(eq(customers.id, lead.id))],
      ["manager seat", () => db.update(customers).set({ leadManagerId: otherManager.id }).where(eq(customers.id, lead.id))],
      ["archive", () => db.update(customers).set({ leadArchived: true }).where(eq(customers.id, lead.id))],
      ["name", () => db.update(customers).set({ name: "Renamed" }).where(eq(customers.id, lead.id))],
      ["phone", () => db.update(customers).set({ phone: "9111111111" }).where(eq(customers.id, lead.id))],
      ["next action", () => db.update(customers).set({ leadNextAction: "Call back" }).where(eq(customers.id, lead.id))],
      ["un-dead", () => db.update(customers).set({ leadDeadAt: null }).where(eq(customers.id, lead.id))],
      ["move the marker", () => db.update(customers).set({ leadDeadById: requester.id }).where(eq(customers.id, lead.id))],
      ["delete", () => db.delete(customers).where(eq(customers.id, lead.id))],
    ];
    for (const [what, fn] of attempts) {
      assert.equal((await dbError(fn)).code, "DL001", what);
    }
    const after = await row(lead.id);
    assert.equal(after.name, lead.name);
    assert.equal(after.leadStage, "lost");
    assert.ok(after.leadDeadAt);
  });

  test("the database refuses every new piece of activity against it", async () => {
    const lead = await deadLead();
    const attempts: Array<[string, () => Promise<unknown>]> = [
      [
        "call",
        () =>
          db.insert(calls).values({
            id: id("cal"),
            customerId: lead.id,
            userId: requester.id,
            outcome: "no_answer",
            startedAt: new Date(),
          } as never),
      ],
      [
        "task",
        () =>
          db.insert(mbosTasks).values({
            id: id("tsk"),
            title: "Chase",
            assignedToUserId: requester.id,
            customerId: lead.id,
            dueDate: "2026-12-01",
            status: "open",
          } as never),
      ],
      [
        "stage transition",
        () =>
          db.insert(leadStageTransitions).values({
            id: id("lst"),
            customerId: lead.id,
            fromStage: "lost",
            toStage: "prospect",
            kind: "passed",
          } as never),
      ],
    ];
    for (const [what, fn] of attempts) {
      assert.equal((await dbError(fn)).code, "DL001", what);
    }
    assert.equal((await db.select().from(orders).where(eq(orders.customerId, lead.id))).length, 0);
  });

  test("system caches may still be rebuilt — a Dead lead does not wedge the recomputes", async () => {
    const lead = await deadLead();
    await db.update(customers).set({ outstanding: 0, lastOrderDate: null, status: "inactive" }).where(eq(customers.id, lead.id));
    await recomputeOutstanding(lead.id);
    await recomputeInactivity(lead.id);
    assert.ok((await row(lead.id)).leadDeadAt);
  });

  test("Reverse Lost is refused for a Dead lead, from the Sales Manager's door", async () => {
    const lead = await deadLead();
    setTestUser(manager);
    const r = await reopenSalesManagerLead({ customerId: lead.id, reasonCode: "customer_responded" });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /permanently Dead/i);
    const row2 = await row(lead.id);
    assert.equal(row2.leadStage, "lost");
    assert.ok(row2.leadDeadAt);
  });

  test("changing the stage through the server action is refused in words", async () => {
    const lead = await deadLead();
    setTestUser(manager);
    const r = await advanceLeadStage({ customerId: lead.id, to: "prospect", reasonCode: "price" });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadStage, "lost");
  });

  describe("the handset", () => {
    async function fieldPrincipal() {
      const field = await makeUser("Field Man", "associate", { crm: false });
      await db.insert(appAccess).values({ id: id("aca"), userId: field.id, app: "field" });
      return {
        field,
        principal: {
          user: field,
          deviceId: "probe-device",
          role: "associate",
          scope: { kind: "all" },
        } as unknown as MbosPrincipal,
      };
    }

    const item = (entityType: SyncItem["entityType"], payload: Record<string, unknown>, entityId = id("mbos_x")): SyncItem => ({
      queueId: id("q"),
      entityType,
      entityId,
      op: "create",
      idempotencyKey: `${entityId}:create:${randomUUID()}`,
      clientCreatedAt: Date.now(),
      payload,
    });

    test("a visit, an order, a lead edit, a task and a note against it are all refused — never retried", async () => {
      const { principal } = await fieldPrincipal();
      const lead = await deadLead();
      const items = [
        item("visit", { customerId: lead.id, checkInAt: new Date().toISOString() }),
        item("order", { customerId: lead.id, lines: [] }),
        item("lead", { stage: "prospect" }, lead.id),
        item("task", { customerId: lead.id, title: "x" }),
        item("internal_note", { customerId: lead.id, body: "x" }),
        item("complaint", { customerId: lead.id }),
        item("sample", { customerId: lead.id }),
      ];
      const results = await ingestSyncBatch(principal, items);
      for (const [i, r] of results.entries()) {
        assert.equal(r.status, "rejected", `${items[i].entityType}: ${JSON.stringify(r)}`);
        assert.match(JSON.stringify(r), /permanently Dead/);
      }
      const after = await row(lead.id);
      assert.equal(after.leadStage, "lost");
      assert.ok(after.leadDeadAt);
      assert.equal((await db.select().from(orders).where(eq(orders.customerId, lead.id))).length, 0);
    });
  });
});

describe("G — the background jobs do not trip over a Dead lead", () => {
  test("the staleness sweep skips it and the nurture pass raises nothing", async () => {
    const lead = await deadLead({ leadLastActivityDate: "2020-01-01", leadArchived: false });
    await ageLeads();
    const after = await row(lead.id);
    assert.equal(after.leadArchived, false, "a Dead lead is never swept into the archive");
    assert.ok(after.leadDeadAt);

    const raised = await db.transaction((tx) =>
      raiseNurtureTasks(tx as never, {
        customerId: lead.id,
        events: [{ trigger: "prospect_created", sourceId: lead.id, on: "2026-10-01" }] as never,
        today: "2026-10-20",
        config: { sampleReviewChaseDays: [2, 4, 6] },
      }),
    );
    assert.equal(raised, 0);
    assert.equal((await db.select().from(mbosTasks).where(eq(mbosTasks.customerId, lead.id))).length, 0);
  });

  test("the full nightly and hourly jobs run with a Dead lead in the book, and leave it exactly as it was", async () => {
    const lead = await deadLead({ leadLastActivityDate: "2020-01-01" });
    const before = await row(lead.id);
    const results = [...(await runNightly(admin.id)), ...(await runHourly(admin.id))];
    const failed = results.filter((r) => (r as { status?: string }).status === "failed");
    assert.deepEqual(failed.map((r) => JSON.stringify(r)), [], "no job failed on a Dead lead");
    const after = await row(lead.id);
    for (const k of ["leadStage", "kind", "ownerId", "leadArchived", "leadDeadAt", "leadManagerId", "name", "phone", "leadNextAction"] as const) {
      assert.deepEqual(after[k], before[k], k);
    }
  });

  test("the whole nightly and hourly MBOS passes run with a Dead lead in the book", async () => {
    const lead = await deadLead({ leadLastActivityDate: "2020-01-01" });
    // A Dead lead that once had a sample out must not make the chasers throw.
    await mbosNightly();
    await mbosHourly();
    const after = await row(lead.id);
    assert.ok(after.leadDeadAt);
    assert.equal(after.leadArchived, false);
  });
});

describe("H — Lost keeps working, and the lists read right", () => {
  test("a normal Lost lead can still be reversed", async () => {
    const lead = await makeLead({ leadStage: "lost", leadLostReason: "price", leadManagerId: manager.id });
    await db.insert(leadStageTransitions).values({
      id: id("lst"),
      customerId: lead.id,
      fromStage: "qualification",
      toStage: "lost",
      kind: "passed",
      salesType: "direct",
      reasonCode: "price",
    } as never);
    setTestUser(manager);
    const r = await reopenSalesManagerLead({ customerId: lead.id, reasonCode: "customer_responded" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.notEqual((await row(lead.id)).leadStage, "lost");
    assert.equal((await row(lead.id)).leadDeadAt, null);
  });

  test("a rejected lead can still be reversed afterwards", async () => {
    const lead = await makeLead();
    assert.equal((await ask(lead.id)).ok, true);
    const [req] = await requestsOf(lead.id);
    setTestUser(manager);
    assert.equal((await decideDeadRequest({ requestId: req.id, approve: false, note: "No" })).ok, true);
    const r = await reopenSalesManagerLead({ customerId: lead.id, reasonCode: "customer_responded" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  test("Dead leads stay in the Lost list with a Dead flag, and only approved ones are on the Dead list", async () => {
    const dead = await deadLead();
    const pending = await makeLead();
    setTestUser(requester);
    assert.equal((await ask(pending.id)).ok, true);
    const plain = await makeLead();

    setTestUser(admin);
    const lost = await lostLeadsPage({ perPage: 50 });
    const byId = new Map(lost.rows.map((r) => [r.id, r]));
    assert.equal(lost.total, 3, "Dead leads are still counted as Lost");
    assert.ok(byId.get(dead.id)?.deadAt);
    assert.equal(byId.get(pending.id)?.deadAt, null);
    assert.ok(byId.get(pending.id)?.deadRequestPending);
    assert.equal(byId.get(plain.id)?.deadRequestPending, false);

    const list = await deadLeadsPage({});
    assert.deepEqual(list.rows.map((r) => r.id), [dead.id], "pending and plain Lost are NOT on the Dead page");
    assert.equal(list.rows[0].approvedByName, "Manoj Manager");
    assert.equal(list.rows[0].requestedByName, "Rina Requester");
    assert.equal(list.rows[0].deadReasonCode, "no_response");
  });
});

describe("I — archived Lost leads are eligible", () => {
  test("an archived Lost lead can be asked about and approved, in the action and the service", async () => {
    const lead = await makeLead({ leadArchived: true, leadArchivedAt: new Date() });
    setTestUser(requester);
    const r = await ask(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    await approve(lead.id);
    const after = await row(lead.id);
    assert.ok(after.leadDeadAt);
    assert.equal(after.leadArchived, true, "still archived, and now Dead as well");
  });

  test("the list row that draws the menu says it is eligible", async () => {
    const lead = await makeLead({ leadArchived: true, leadArchivedAt: new Date() });
    const { deadRequestEligibility } = await import("@/lib/lead-dead");
    assert.deepEqual(deadRequestEligibility({ stage: "lost", deadAt: null, pending: false }), { offer: true });
    setTestUser(admin);
    const lost = await lostLeadsPage({ perPage: 50 });
    assert.ok(lost.rows.some((x) => x.id === lead.id), "archived Lost leads are in the Lost list, so Dead can be asked from there");
  });
});

describe("J — the requester can withdraw a pending request", () => {
  test("it is closed as withdrawn, the lead stays Lost, only the approver is told, and it is kept in the history", async () => {
    const lead = await makeLead();
    assert.equal((await ask(lead.id, { note: "Tried a fortnight" })).ok, true);
    const [req] = await requestsOf(lead.id);
    await db.delete(notifications);

    const r = await withdrawDeadRequest({ requestId: req.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const [kept] = await requestsOf(lead.id);
    assert.equal(kept.state, "withdrawn");
    assert.equal(kept.decidedById, requester.id);
    assert.ok(kept.decidedAt);

    const after = await row(lead.id);
    assert.equal(after.leadDeadAt, null);
    assert.equal(after.leadStage, "lost");

    const bells = await db.select().from(notifications);
    assert.deepEqual(bells.map((b) => b.userId), [manager.id], "only the approver is told");
    assert.equal((await deadQueueFor(manager.id)).length, 0, "it leaves the approver's queue");
    assert.equal((await db.select().from(auditLog).where(eq(auditLog.action, "lead.dead.withdraw"))).length, 1);
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.customerId, lead.id));
    assert.ok(events.some((e) => e.sourceRecordId?.endsWith(":withdrawn")));
  });

  test("only the person who asked may withdraw — not the approver, another manager or an administrator", async () => {
    const lead = await makeLead();
    assert.equal((await ask(lead.id)).ok, true);
    const [req] = await requestsOf(lead.id);
    for (const who of [manager, otherManager, admin]) {
      setTestUser(who);
      const r = await withdrawDeadRequest({ requestId: req.id });
      assert.equal(r.ok, false, who.name);
    }
    assert.equal((await requestsOf(lead.id))[0].state, "pending");
  });

  test("after withdrawing, the approver cannot decide it, Reverse Lost works again, and a fresh request can be sent", async () => {
    const lead = await makeLead({ leadManagerId: manager.id });
    await db.insert(leadStageTransitions).values({
      id: id("lst"), customerId: lead.id, fromStage: "qualification", toStage: "lost", kind: "passed", salesType: "direct", reasonCode: "price",
    } as never);
    assert.equal((await ask(lead.id)).ok, true);
    const [req] = await requestsOf(lead.id);
    assert.equal((await withdrawDeadRequest({ requestId: req.id })).ok, true);

    setTestUser(manager);
    const decided = await decideDeadRequest({ requestId: req.id, approve: true, confirmed: true });
    assert.equal(decided.ok, false);
    assert.match(!decided.ok ? decided.error : "", /withdrawn/i);
    assert.equal((await row(lead.id)).leadDeadAt, null);

    // The loss is unfrozen: it can be reversed…
    const reversed = await reopenSalesManagerLead({ customerId: lead.id, reasonCode: "customer_responded" });
    assert.equal(reversed.ok, true, reversed.ok ? "" : reversed.error);
  });

  test("a withdrawn request can be followed by a fresh one", async () => {
    const lead = await makeLead();
    assert.equal((await ask(lead.id)).ok, true);
    const [req] = await requestsOf(lead.id);
    assert.equal((await withdrawDeadRequest({ requestId: req.id })).ok, true);
    assert.equal((await ask(lead.id, { note: "Asking again" })).ok, true);
    assert.deepEqual((await requestsOf(lead.id)).map((r) => r.state), ["withdrawn", "pending"]);
  });

  test("withdrawing twice, or after the decision, is refused in words", async () => {
    const a = await makeLead();
    assert.equal((await ask(a.id)).ok, true);
    const [ra] = await requestsOf(a.id);
    assert.equal((await withdrawDeadRequest({ requestId: ra.id })).ok, true);
    const twice = await withdrawDeadRequest({ requestId: ra.id });
    assert.equal(twice.ok, false);
    assert.match(!twice.ok ? twice.error : "", /already withdrawn/i);

    const b = await makeLead();
    assert.equal((await ask(b.id)).ok, true);
    await approve(b.id);
    const [rb] = await requestsOf(b.id);
    setTestUser(requester);
    const late = await withdrawDeadRequest({ requestId: rb.id });
    assert.equal(late.ok, false);
    assert.match(!late.ok ? late.error : "", /approved this request before you withdrew/i);
    assert.ok((await row(b.id)).leadDeadAt, "the approval stands");
  });

  test("the database refuses a withdrawal recorded as anybody but the requester", async () => {
    const lead = await makeLead();
    assert.equal((await ask(lead.id)).ok, true);
    const e = await dbError(() =>
      db
        .update(leadDeadRequests)
        .set({ state: "withdrawn", decidedById: manager.id, decidedAt: new Date() })
        .where(eq(leadDeadRequests.customerId, lead.id)),
    );
    assert.equal(e.code, "23514");
  });

  test("RACE: an approval and a withdrawal at the same instant make exactly one outcome, and the lead agrees with it", async () => {
    for (let i = 0; i < 6; i += 1) {
      const lead = await makeLead();
      setTestUser(requester);
      assert.equal((await ask(lead.id)).ok, true);
      const [req] = await requestsOf(lead.id);

      // Both actors resolve from one shared test seam, so the two calls are made
      // through the service layer with their own identities.
      const { decideLeadDead, withdrawLeadDead } = await import("@/lib/services/lead-dead-service");
      const [approved, withdrawn] = await Promise.all([
        decideLeadDead({ actorUserId: manager.id, hat: null, requestId: req.id, approve: true }),
        withdrawLeadDead({ actorUserId: requester.id, hat: null, requestId: req.id }),
      ]);
      assert.equal([approved, withdrawn].filter((r) => r.ok).length, 1, `round ${i}: exactly one wins`);

      const [final] = await requestsOf(lead.id);
      const after = await row(lead.id);
      if (approved.ok) {
        assert.equal(final.state, "approved");
        assert.ok(after.leadDeadAt, "approved means Dead");
        assert.equal(final.decidedById, manager.id);
      } else {
        assert.equal(final.state, "withdrawn");
        assert.equal(after.leadDeadAt, null, "withdrawn means the lead is untouched");
        assert.equal(final.decidedById, requester.id);
      }
    }
  });
});

describe("K — handset work queued BEFORE approval but synced AFTER is rejected", () => {
  test("a visit and an order stamped before the lead became Dead are refused, not retried, not stored", async () => {
    const field = await makeUser("Field Man", "associate", { crm: false });
    await db.insert(appAccess).values({ id: id("aca"), userId: field.id, app: "field" });
    const principal = { user: field, deviceId: "probe", role: "associate", scope: { kind: "all" } } as unknown as MbosPrincipal;

    const lead = await makeLead();
    // The salesman recorded these while the lead was still only Lost…
    const queuedAt = Date.now() - 6 * 3600_000;
    const mk = (entityType: SyncItem["entityType"], payload: Record<string, unknown>): SyncItem => {
      const entityId = id("mbos_q");
      return { queueId: id("q"), entityType, entityId, op: "create", idempotencyKey: `${entityId}:create:${randomUUID()}`, clientCreatedAt: queuedAt, payload };
    };
    // …then the manager approved it, and only then did his phone find a signal.
    setTestUser(requester);
    assert.equal((await ask(lead.id)).ok, true);
    await approve(lead.id);

    const results = await ingestSyncBatch(principal, [
      mk("visit", { customerId: lead.id, checkInAt: new Date(queuedAt).toISOString() }),
      mk("order", { customerId: lead.id, lines: [] }),
    ]);
    for (const r of results) {
      assert.equal(r.status, "rejected", JSON.stringify(r));
      assert.match(JSON.stringify(r), /permanently Dead/);
    }
    assert.equal((await db.select().from(orders).where(eq(orders.customerId, lead.id))).length, 0);
    assert.equal((await row(lead.id)).leadStage, "lost");
  });
});
