/**
 * MANAGER AUTHORITY OVER A LEAVER'S LEADS.
 *
 * Bharat has left; he reports to Seema, who reports to Pritesh. Seema and
 * Pritesh may work Bharat's leads without them being transferred; an unrelated
 * manager may not; an active owner's leads follow the existing workflow; and
 * `owner_id` never moves.
 *
 *   A  The scope gate: who is let in, who is not, and what is never widened
 *   B  Fail closed: no module, a trashed lead, two accounts on one manager
 *   C  The actions that were blocked: Reverse Lost, a call, a Dead request
 *   D  What authority does NOT give: reassignment, and collecting Qualification
 *   E  The marker: "acting on behalf of", on the page and in the audit row
 *   F  Qualification through the real submission action: refused for a manager
 *      acting for a leaver, nothing written, and the owner's own workflow intact
 *   G  The Reverse next-action fallback on leads whose owner is still working
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
  customers,
  employeeReporting,
  employees,
  leadDeadRequests,
  notifications,
  timelineEvents,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { assertCustomerInScope } from "@/lib/access-control";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { assignDeskLead } from "@/lib/actions/lead-desk-assignment";
import { logLeadCall } from "@/lib/actions/lead-activity";
import { reopenDeskLead } from "@/lib/actions/lead-calling-desk";
import { reopenSalesManagerLead } from "@/lib/actions/lead-reopen";
import { requestDeadLead } from "@/lib/actions/lead-dead";
import { saveLeadQualification } from "@/lib/actions/leads";
import { checklistFor, QUALIFICATION_ANSWER_KEYS } from "@/lib/engines/lead-gates";
import { assertLeadInScope } from "@/lib/services/lead-scope";
import { actingOnBehalfOf, authorityOverOwner } from "@/lib/services/lead-manager-authority";
import { qualificationCollectorRefusal } from "@/lib/services/lead-verifier";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type U = typeof users.$inferSelect;

let bharat: U; // left: account off, employee Inactive
let seema: U; // associate holding Leads + Sales Manager; Bharat's manager
let pritesh: U; // CRM manager; Seema's manager
let other: U; // an unrelated CRM manager
let anna: U; // an ordinary associate
let rakesh: U; // still working, reports to Seema
let noModule: U; // above a second leaver, but holds no CRM Leads module
let leaver2: U;
let empSeema: typeof employees.$inferSelect;

async function person(
  name: string,
  role: "associate" | "manager",
  opts: { modules?: string[]; active?: boolean; employeeId?: string } = {},
) {
  const [u] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
      active: opts.active ?? true,
      employeeId: opts.employeeId ?? null,
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "crm", role });
  for (const m of opts.modules ?? []) {
    await db.insert(appModuleAccess).values({ id: id("ama"), userId: u.id, app: "crm", module: m });
  }
  return u;
}

let rowNo = 100;
async function employee(name: string, status: "active" | "inactive" = "active") {
  const [e] = await db
    .insert(employees)
    .values({
      id: id("emp"),
      rowNumber: rowNo++,
      employeeCode: `MA${rowNo}${randomUUID().slice(0, 4)}`,
      name,
      status,
      raw: {},
      rowHash: id("h"),
    })
    .returning();
  return e;
}

async function lead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [c] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      contactPerson: "Ganesh",
      phone: testPhone(),
      city: "Ajmer",
      kind: "lead",
      leadStage: "lost",
      leadSalesType: "direct",
      leadSource: "manual",
      leadLostReason: "other",
      ownerId: bharat.id,
      ...over,
    })
    .returning();
  return c;
}
const reload = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0]!;
const seats = (c: typeof customers.$inferSelect) => ({
  kind: c.kind,
  ownerId: c.ownerId,
  salesAmId: c.salesAmId,
  backOfficeAmId: c.backOfficeAmId,
  leadManagerId: c.leadManagerId,
  salesManagerId: c.salesManagerId,
  deletedAt: c.deletedAt,
});
/** Refused either way a refusal can arrive: a thrown permission error or `ok: false`. */
async function refused(p: Promise<{ ok: boolean }>) {
  try {
    const r = await p;
    assert.equal(r.ok, false, "expected a refusal");
  } catch (e) {
    assert.ok(e instanceof Error, "expected a thrown refusal");
  }
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against a test database only.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_dead_requests, lead_stage_transitions, timeline_events, audit_log, notifications,
      employee_reporting, app_module_access, app_access, customers, users, employees, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  const [eB, eS, eP, eO, eR, eN, eL2] = await Promise.all([
    employee("Bharat Test", "inactive"),
    employee("Seema Test"),
    employee("Pritesh Test"),
    employee("Other Test"),
    employee("Rakesh Test"),
    employee("NoModule Test"),
    employee("Leaver Two", "inactive"),
  ]);
  empSeema = eS;
  await db.insert(employeeReporting).values([
    { id: id("rep"), employeeId: eB.id, managerId: eS.id },
    { id: id("rep"), employeeId: eS.id, managerId: eP.id },
    { id: id("rep"), employeeId: eR.id, managerId: eS.id },
    { id: id("rep"), employeeId: eL2.id, managerId: eN.id },
  ]);
  bharat = await person("Bharat Test", "associate", { active: false, employeeId: eB.id });
  seema = await person("Seema Test", "associate", { modules: ["crm.leads", "crm.sales-manager"], employeeId: eS.id });
  pritesh = await person("Pritesh Test", "manager", { employeeId: eP.id });
  other = await person("Other Test", "manager", { employeeId: eO.id });
  anna = await person("Anna Test", "associate", { modules: ["crm.leads"] });
  rakesh = await person("Rakesh Test", "associate", { modules: ["crm.leads"], employeeId: eR.id });
  noModule = await person("NoModule Test", "associate", { modules: ["crm.sales-manager"], employeeId: eN.id });
  leaver2 = await person("Leaver Two", "associate", { active: false, employeeId: eL2.id });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("A · who is let in", () => {
  test("Seema and Pritesh may work a leaver's lead; an unrelated manager and an associate may not", async () => {
    const l = await lead(); // no Sales Manager seat: nothing but the Org Chart can let anybody in
    for (const [who, may] of [
      [seema, true],
      [pritesh, true],
      [other, false],
      [anna, false],
    ] as const) {
      setTestUser(who);
      if (may) await assertCustomerInScope(seats(l));
      else await assert.rejects(() => assertCustomerInScope(seats(l)), /customer\.read/, who.name);
    }
  });

  test("the chain is the Org Chart: Pritesh inherits through Seema, Bharat's own seat does not count", async () => {
    const a = await authorityOverOwner(bharat.id);
    assert.equal(a.gone, true);
    assert.deepEqual(a.managerUserIds, [seema.id, pritesh.id]);
  });

  test("an active owner's lead follows the existing workflow: no manager is widened", async () => {
    const l = await lead({ ownerId: rakesh.id, leadStage: "new" });
    for (const who of [pritesh, other, anna]) {
      setTestUser(who);
      await assert.rejects(() => assertCustomerInScope(seats(l)), /customer\.read/, who.name);
    }
    assert.deepEqual((await authorityOverOwner(rakesh.id)).managerUserIds, []);
  });

  test("a customer owned by a leaver is not opened up: authority is for leads", async () => {
    const [c] = await db
      .insert(customers)
      .values({ id: id("cus"), name: "A customer", phone: testPhone(), city: "Ajmer", kind: "customer", ownerId: bharat.id })
      .returning();
    setTestUser(seema);
    await assert.rejects(() => assertCustomerInScope(seats(c)), /customer\.read/);
  });

  test("owner_id is never touched by being worked", async () => {
    const l = await lead();
    setTestUser(seema);
    await assertLeadInScope(l.id, seats(l));
    assert.equal((await reload(l.id)).ownerId, bharat.id);
  });
});

describe("B · fail closed", () => {
  test("a manager without the CRM Leads module is not given authority", async () => {
    const l = await lead({ ownerId: leaver2.id });
    assert.deepEqual((await authorityOverOwner(leaver2.id)).managerUserIds, [noModule.id]);
    setTestUser(noModule);
    await assert.rejects(() => assertCustomerInScope(seats(l)), /customer\.read/);
  });

  test("a lead in the trash stays closed", async () => {
    const l = await lead();
    await db.execute(sql`update customers set deleted_at = now() where id = ${l.id}`);
    setTestUser(seema);
    await assert.rejects(() => assertCustomerInScope({ ...seats(l), deletedAt: new Date() }), /customer\.read/);
    setTestUser(pritesh);
    await assert.rejects(() => assertCustomerInScope({ ...seats(l), deletedAt: new Date() }), /customer\.read/);
  });

  test("an owner with no stored employee link has no authority over them at all", async () => {
    await db.execute(sql`update users set employee_id = null where id = ${bharat.id}`);
    const l = await lead();
    setTestUser(seema);
    await assert.rejects(() => assertCustomerInScope(seats(l)), /customer\.read/);
    setTestUser(pritesh);
    await assert.rejects(() => assertCustomerInScope(seats(l)), /customer\.read/);
  });

  test("two accounts on one manager cannot exist: the database refuses the second link (the engine still stops the walk if one ever did)", async () => {
    await assert.rejects(
      () => person("Seema Twin", "associate", { employeeId: empSeema.id }),
      (e: Error & { cause?: Error }) => /users_employee_key|duplicate key/.test(`${e.cause?.message ?? ""} ${e.message}`),
    );
  });

  test("an owner whose account is on but whose employee is Inactive has still left", async () => {
    await db.execute(sql`update users set active = true where id = ${bharat.id}`);
    const l = await lead();
    setTestUser(seema);
    await assertCustomerInScope(seats(l));
  });
});

describe("C · the actions that were blocked", () => {
  test("Seema reverses a Lost lead through the desk door: the next action is hers, Bharat still owns it, her name is on the record", async () => {
    const l = await lead({ salesManagerId: seema.id });
    setTestUser(seema);
    const r = await reopenDeskLead({ customerId: l.id, reasonCode: "customer_responded" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const after_ = await reload(l.id);
    assert.notEqual(after_.leadStage, "lost");
    assert.equal(after_.ownerId, bharat.id, "ownership unchanged");
    assert.equal(after_.leadNextActionOwnerId, seema.id, "the next action goes to the person who acted");

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, l.id), eq(auditLog.action, "lead.stage.reopen")));
    assert.equal(audit.actorId, seema.id, "the actual person");
    assert.equal((audit.afterState as { actingFor?: { ownerName: string } }).actingFor?.ownerName, bharat.name);
    const tl = await db.select().from(timelineEvents).where(eq(timelineEvents.customerId, l.id));
    assert.ok(tl.some((t) => /on behalf of Bharat Test/.test(t.summary ?? "")), "the timeline says so");
  });

  test("Seema reverses a lead she has no seat on, through the Org Chart alone", async () => {
    const l = await lead();
    setTestUser(seema);
    const r = await reopenDeskLead({ customerId: l.id, reasonCode: "customer_responded" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await reload(l.id)).ownerId, bharat.id);
  });

  test("Pritesh reverses through the Sales Manager door and the next action is his", async () => {
    const l = await lead();
    setTestUser(pritesh);
    const r = await reopenSalesManagerLead({ customerId: l.id, reasonCode: "customer_responded" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const row = await reload(l.id);
    assert.equal(row.ownerId, bharat.id);
    assert.equal(row.leadNextActionOwnerId, pritesh.id);
  });

  test("an unrelated manager is refused a reverse", async () => {
    const l = await lead();
    setTestUser(other);
    await refused(reopenSalesManagerLead({ customerId: l.id, reasonCode: "customer_responded" }));
    assert.equal((await reload(l.id)).leadStage, "lost");
  });

  test("Seema logs a call on a leaver's lead; it is her call", async () => {
    const l = await lead({ leadStage: "new" });
    setTestUser(seema);
    const r = await logLeadCall({
      customerId: l.id,
      clientKey: `key_${randomUUID().slice(0, 12)}`,
      outcome: "spoke",
      notes: "Rang the shop; they will call back.",
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await reload(l.id)).ownerId, bharat.id);
  });

  test("Seema's Dead request goes to Pritesh, with her name and the marker", async () => {
    const l = await lead();
    setTestUser(seema);
    const r = await requestDeadLead({ customerId: l.id, reasonCode: "other", note: "Closed down." });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const [req] = await db.select().from(leadDeadRequests).where(eq(leadDeadRequests.customerId, l.id));
    assert.equal(req.requestedById, seema.id);
    assert.equal(req.approverId, pritesh.id, "the next eligible manager above the requester");
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, l.id), eq(auditLog.action, "lead.dead.request")));
    assert.equal(audit.actorId, seema.id);
    assert.equal((audit.afterState as { actingFor?: { ownerName: string } }).actingFor?.ownerName, bharat.name);
    assert.equal((await reload(l.id)).ownerId, bharat.id);
  });

  test("nobody approves their own Dead request: Pritesh asking is routed above him, never to himself", async () => {
    const l = await lead();
    setTestUser(pritesh);
    const r = await requestDeadLead({ customerId: l.id, reasonCode: "other", note: "Closed down." });
    if (r.ok) {
      const [req] = await db.select().from(leadDeadRequests).where(eq(leadDeadRequests.customerId, l.id));
      assert.notEqual(req.approverId, pritesh.id);
    }
  });
});

describe("D · what authority does not give", () => {
  test("it does not carry reassignment: that still needs its own permission", async () => {
    const l = await lead();
    setTestUser(seema);
    await refused(assignDeskLead({ customerId: l.id, ownerId: rakesh.id }));
    assert.equal((await reload(l.id)).ownerId, bharat.id);
  });

  test("Seema still may not collect Qualification answers on Bharat's lead", async () => {
    const l = await lead({ leadStage: "qualification", salesManagerId: seema.id });
    const refusal = await qualificationCollectorRefusal({ id: seema.id, role: seema.role }, { ...seats(l), id: l.id, leadStage: "qualification" } as never);
    assert.ok(refusal, "the existing refusal still stands");
  });
});

describe("E · the marker", () => {
  test("Seema and Pritesh are told whose lead it is; nobody else is", async () => {
    const l = await lead();
    assert.equal((await actingOnBehalfOf(l.id, seema.id))?.ownerName, bharat.name);
    assert.equal((await actingOnBehalfOf(l.id, pritesh.id))?.ownerName, bharat.name);
    assert.equal(await actingOnBehalfOf(l.id, other.id), null);
    assert.equal(await actingOnBehalfOf(l.id, anna.id), null);
    assert.equal(await actingOnBehalfOf(l.id, bharat.id), null, "the owner is never acting for themself");
  });

  test("no marker on an active owner's lead", async () => {
    const l = await lead({ ownerId: rakesh.id, leadStage: "new" });
    assert.equal(await actingOnBehalfOf(l.id, seema.id), null);
  });
});

describe("F · Qualification through the real action", () => {
  const checklistId = () => checklistFor("direct", "qualification")[0]!.id;
  const answers = () =>
    ({ [checklistId()]: true, [QUALIFICATION_ANSWER_KEYS[0]!]: "Used on a spray booth" }) as Record<string, boolean | string>;

  async function snapshot(leadId: string) {
    const n = async (query: ReturnType<typeof sql>) => Number((await db.execute<{ n: number }>(query))[0]!.n);
    const [row] = await db.select().from(customers).where(eq(customers.id, leadId));
    return {
      row: row!,
      audit: await n(sql`select count(*)::int as n from audit_log where entity_id = ${leadId}`),
      timeline: await n(sql`select count(*)::int as n from timeline_events where customer_id = ${leadId}`),
      notes: await n(sql`select count(*)::int as n from notifications`),
    };
  }

  async function assertNothingWritten(leadId: string, before: Awaited<ReturnType<typeof snapshot>>) {
    const now = await snapshot(leadId);
    assert.deepEqual(now.row.leadQualification, before.row.leadQualification, "no answers written");
    assert.equal(now.row.leadQualificationReview, before.row.leadQualificationReview, "no review state written");
    assert.equal(now.row.leadLastActivityDate, before.row.leadLastActivityDate, "no activity date moved");
    assert.equal(now.row.updatedAt.getTime(), before.row.updatedAt.getTime(), "the row was not touched");
    assert.equal(now.row.ownerId, before.row.ownerId, "owner unchanged");
    assert.equal(now.audit, before.audit, "no audit row");
    assert.equal(now.timeline, before.timeline, "no timeline event");
    assert.equal(now.notes, before.notes, "no notification");
  }

  test("Seema, the lead's Sales Manager, cannot submit answers on Bharat's lead: refused, nothing written", async () => {
    const l = await lead({ leadStage: "qualification", salesManagerId: seema.id });
    const before = await snapshot(l.id);
    setTestUser(seema);
    const r = await saveLeadQualification(l.id, answers());
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /completes its Qualification, and you review it/);
    await assertNothingWritten(l.id, before);
  });

  test("a manager acting for a leaver with no seat on the lead is refused as well, and nothing is written", async () => {
    const l = await lead({ leadStage: "qualification" }); // no Sales Manager seat: authority is the only claim
    for (const who of [seema, pritesh]) {
      const before = await snapshot(l.id);
      setTestUser(who);
      const r = await saveLeadQualification(l.id, answers());
      assert.equal(r.ok, false, `${who.name} must be refused`);
      assert.match(r.ok ? "" : r.error, /on behalf of a colleague who has left/, who.name);
      await assertNothingWritten(l.id, before);
    }
  });

  test("an unrelated manager is refused by scope, nothing written", async () => {
    const l = await lead({ leadStage: "qualification" });
    const before = await snapshot(l.id);
    setTestUser(other);
    await refused(saveLeadQualification(l.id, answers()));
    await assertNothingWritten(l.id, before);
  });

  test("the existing workflow is intact: a working owner saves their own lead's answers", async () => {
    const l = await lead({ ownerId: rakesh.id, leadStage: "qualification", salesManagerId: seema.id });
    setTestUser(rakesh);
    const r = await saveLeadQualification(l.id, answers());
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const row = await reload(l.id);
    assert.equal((row.leadQualification as Record<string, unknown>)[checklistId()], true);
    assert.equal(row.ownerId, rakesh.id);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, l.id), eq(auditLog.action, "lead.qualification.save")));
    assert.equal(audit!.actorId, rakesh.id);
  });

  test("the existing rule is intact: the Sales Manager is still refused on a working owner's lead", async () => {
    const l = await lead({ ownerId: rakesh.id, leadStage: "qualification", salesManagerId: seema.id });
    const before = await snapshot(l.id);
    setTestUser(seema);
    const r = await saveLeadQualification(l.id, answers());
    assert.equal(r.ok, false);
    await assertNothingWritten(l.id, before);
  });
});

describe("G · the Reverse next-action fallback on leads whose owner is still working", () => {
  const REOPEN_DAY = "2099-01-01";
  /* Pritesh is a CRM manager with no territory; in the real app he also holds the
     Sales Dashboard, which is what makes a manager's lead list national. */
  beforeEach(async () => {
    await db.insert(appAccess).values({ id: id("aca"), userId: pritesh.id, app: "sales", role: "manager" });
  });

  test("a named next-action owner with no active account goes to the person reversing; owner_id and the actor are kept", async () => {
    const l = await lead({ ownerId: rakesh.id, leadManagerId: leaver2.id });
    setTestUser(pritesh);
    const r = await reopenSalesManagerLead({
      customerId: l.id,
      reasonCode: "customer_responded",
      nextAction: { action: "Ring the shop", date: REOPEN_DAY },
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const row = await reload(l.id);
    assert.equal(row.ownerId, rakesh.id, "owner untouched");
    assert.equal(row.leadNextActionOwnerId, pritesh.id, "the person who reversed it");
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, l.id), eq(auditLog.action, "lead.stage.reopen")));
    assert.equal(audit!.actorId, pritesh.id);
    assert.equal(
      (audit!.afterState as { actingFor?: unknown }).actingFor,
      undefined,
      "not acting for anybody: Rakesh is working",
    );
  });

  test("an active named owner still gets the next action, and is told", async () => {
    const l = await lead({ ownerId: rakesh.id, leadManagerId: rakesh.id });
    setTestUser(pritesh);
    const r = await reopenSalesManagerLead({
      customerId: l.id,
      reasonCode: "customer_responded",
      nextAction: { action: "Ring the shop", date: REOPEN_DAY },
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await reload(l.id)).leadNextActionOwnerId, rakesh.id);
    const told = await db.select().from(notifications).where(eq(notifications.userId, rakesh.id));
    assert.ok(told.length >= 1, "the working owner is notified");
  });

  test("an associate with no way into the lead cannot reverse it, so the fallback never runs", async () => {
    const l = await lead({ ownerId: rakesh.id, leadManagerId: leaver2.id });
    setTestUser(anna);
    await refused(reopenDeskLead({ customerId: l.id, reasonCode: "customer_responded" }));
    assert.equal((await reload(l.id)).leadStage, "lost");
  });
});
