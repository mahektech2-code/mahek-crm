/**
 * The CRM Sales Manager workspace: ONE scope, for what it draws and for what it
 * lets a person do.
 *
 * `/crm/leads/sales-manager` mounts the same dashboard, funnel, list and record
 * that `/sales-lead-pipeline` does, and none of this file re-tests THAT — the
 * Sales Manager suite next to it does, and must go on passing unchanged. What
 * is pinned here is only what the CRM mounting adds:
 *
 *   S  the scope is `customers.sales_manager_id` = the signed-in person, an
 *      administrator sees all, and a lead with an owner but no Sales Manager, or
 *      with neither, is in NOBODY's book;
 *   W  the write side resolves the SAME scope, so a lead that is drawn is a lead
 *      that can be acted on and one that is not drawn cannot be — whatever
 *      level the person's CRM hat happens to be;
 *   I  the interaction with the salesman is one lead, not two: an action here
 *      changes the row the handset reads, and creates nothing;
 *   X  nothing outside the workspace moved — the territory scope every other
 *      screen reads is still what it was.
 *
 * Runs against mahekone_test with the REAL services and the REAL actions. The
 * workspace travels on a request header in production; a test has no request,
 * so `setTestWorkspace` stands in for the header `src/proxy.ts` writes.
 */
import { after, before, beforeEach, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, customers, products, timelineEvents, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { setLeadNextAction } from "@/lib/actions/leads";
import { reassignLead } from "@/lib/actions/sales";
import { verifyProspect } from "@/lib/actions/sales-manager-pipeline";
import { CRM_SALES_MANAGER_WORKSPACE } from "@/proxy";
import { setTestWorkspace } from "@/lib/services/crm-sales-manager-scope";
import { QUAL_NEXT } from "@/lib/services/lead-qualification-flow-service";
import { NO_SALESMAN, disabledReasons, groupBySalesman } from "@/lib/sales-lead-pipeline/desk";
import {
  pipelineDashboard,
  pipelineDesk,
  pipelineFunnel,
  pipelineLead,
  pipelineList,
  pipelineSidebar,
} from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";
import { leadTileCounts } from "@/lib/services/lead-views-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const DAY = "2026-09-24";
const YESTERDAY = "2026-09-23";
const NEXT_WEEK = "2026-10-01";

type Level = "associate" | "manager" | "admin";

let smA: typeof users.$inferSelect; // a Sales Manager whose CRM hat is ASSOCIATE — the shape production has
let smB: typeof users.$inferSelect;
let smLead: typeof users.$inferSelect; // a Sales Manager whose CRM hat is MANAGER (holds lead.verify)
let admin: typeof users.$inferSelect;
let noModule: typeof users.$inferSelect; // a CRM user narrowed to a different CRM module
let salesman: typeof users.$inferSelect;
let salesman2: typeof users.$inferSelect;
let productId: string;

async function makeUser(
  name: string,
  role: Level,
  apps: { app: "sales" | "crm" | "field" | "admin"; role: Level }[],
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
  for (const a of apps) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: a.app, role: a.role });
  for (const key of modules) {
    await db.insert(appModuleAccess).values({ id: id("ama"), userId: row.id, app: "crm", module: key });
  }
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
      leadSource: "manual",
      leadStageSince: YESTERDAY,
      leadLastActivityDate: YESTERDAY,
      ...over,
    })
    .returning();
  return row;
}

const prospectFields = () => ({
  customerType: "retailer" as const,
  leadMonthlyVolumeLitres: 300,
  leadEstimatedPotentialPaise: 9_000_000,
  leadCompetitor: "Local thinner",
  leadRequiredProductId: productId,
  contactPerson: "Ganesh",
  leadDecisionMaker: "Owner",
});

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const customerCount = async () => Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from customers`))[0].n);
const listIds = async () => (await pipelineList(DAY, { q: "", stage: "", view: "", page: 1 })).rows.map((r) => r.id).sort();

let mineA: typeof customers.$inferSelect; // owned by the salesman, Sales Manager = smA
let mineANoOwner: typeof customers.$inferSelect; // Sales Manager = smA, nobody owns it
let mineB: typeof customers.$inferSelect; // Sales Manager = smB
let ownerOnly: typeof customers.$inferSelect; // an owner, and NO Sales Manager
let unassigned: typeof customers.$inferSelect; // neither

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
      mbos_samples, sample_feedback, mbos_approvals, mbos_documents, distributor_profiles, orders, bills,
      calls, notifications, timeline_events, audit_log, app_module_access, app_access, mbos_user_territories,
      customers, products, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  smA = await makeUser("Manager Aye", "associate", [{ app: "crm", role: "associate" }], ["crm.sales-manager"]);
  smB = await makeUser("Manager Bee", "associate", [{ app: "crm", role: "associate" }], ["crm.sales-manager"]);
  smLead = await makeUser("Manager Lead", "manager", [{ app: "crm", role: "manager" }], ["crm.sales-manager"]);
  admin = await makeUser("Big Boss", "admin", [{ app: "crm", role: "admin" }]);
  noModule = await makeUser("Tele Caller", "associate", [{ app: "crm", role: "associate" }], ["crm.leads"]);
  salesman = await makeUser("Salesman One", "associate", [{ app: "field", role: "associate" }]);
  salesman2 = await makeUser("Salesman Two", "associate", [{ app: "field", role: "associate" }]);
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });

  mineA = await makeLead({ name: "Mine A", ownerId: salesman.id, salesManagerId: smA.id });
  mineANoOwner = await makeLead({ name: "Mine A no owner", ownerId: null, salesManagerId: smA.id });
  mineB = await makeLead({ name: "Mine B", ownerId: salesman.id, salesManagerId: smB.id });
  ownerOnly = await makeLead({ name: "Owner only", ownerId: salesman.id, salesManagerId: null });
  unassigned = await makeLead({ name: "Unassigned", ownerId: null, salesManagerId: null });

  setTestWorkspace(CRM_SALES_MANAGER_WORKSPACE);
  setTestUser(smA);
});

afterEach(() => {
  setTestWorkspace(null);
});

after(async () => {
  setTestUser(null);
  setTestWorkspace(null);
  await db.$client.end();
});

/* ═══════════════════════════════════════════════════════════════ S — scope */

describe("S — the scope is the Sales Manager seat, and nothing else", () => {
  test("a Sales Manager sees the leads whose sales_manager_id is theirs — owned or not", async () => {
    assert.deepEqual(await listIds(), [mineA.id, mineANoOwner.id].sort());
    assert.ok(await pipelineLead(mineA.id, DAY), "the record opens");
    assert.ok(await pipelineLead(mineANoOwner.id, DAY), "a lead nobody owns yet, but whose Sales Manager is named, is theirs");
  });

  test("one Sales Manager cannot see another's leads — list, record, or count", async () => {
    setTestUser(smB);
    assert.deepEqual(await listIds(), [mineB.id]);
    assert.equal(await pipelineLead(mineA.id, DAY), null, "another Sales Manager's record is not there to open");
    assert.equal(await pipelineLead(mineANoOwner.id, DAY), null);

    setTestUser(smA);
    assert.equal(await pipelineLead(mineB.id, DAY), null);
  });

  test("an administrator reaches every lead, assigned or not", async () => {
    setTestUser(admin);
    assert.deepEqual(await listIds(), [mineA.id, mineANoOwner.id, mineB.id, ownerOnly.id, unassigned.id].sort());
    assert.ok(await pipelineLead(unassigned.id, DAY));
    assert.ok(await pipelineLead(ownerOnly.id, DAY));
  });

  test("a lead with an owner but NO Sales Manager is in nobody's normal scope", async () => {
    assert.ok(!(await listIds()).includes(ownerOnly.id));
    assert.equal(await pipelineLead(ownerOnly.id, DAY), null);
    setTestUser(smB);
    assert.ok(!(await listIds()).includes(ownerOnly.id));
    assert.equal(await pipelineLead(ownerOnly.id, DAY), null);
  });

  test("a completely unassigned lead is in nobody's normal scope", async () => {
    assert.ok(!(await listIds()).includes(unassigned.id));
    assert.equal(await pipelineLead(unassigned.id, DAY), null);
  });

  test("the counts and the funnel are counted over the same book, not the company's", async () => {
    const t = await leadTileCounts(DAY);
    assert.equal(t.suspects, 2, "the tile counts the two suspects in this book");

    const funnel = await pipelineFunnel(DAY);
    assert.equal(funnel.direct.find((f) => f.stage === "suspect")?.count, 2);

    const dash = await pipelineDashboard(DAY);
    assert.equal(dash.book.suspects, 2);

    setTestUser(admin);
    assert.equal((await leadTileCounts(DAY)).suspects, 5, "an administrator's book is the whole one");
  });

  test("the search narrows inside the book and never widens past it", async () => {
    const own = await pipelineList(DAY, { q: "Mine", stage: "", view: "", page: 1 });
    assert.deepEqual(own.rows.map((r) => r.id).sort(), [mineA.id, mineANoOwner.id].sort(), "Mine B is not offered to Manager Aye");
    const none = await pipelineList(DAY, { q: "Unassigned", stage: "", view: "", page: 1 });
    assert.equal(none.rows.length, 0);
  });

  test("the module gate is the CRM module — and the Sales Dashboard is not involved", async () => {
    assert.equal(await canOpenModule(smA.id, "crm.sales-manager"), true);
    assert.equal(await canOpenModule(noModule.id, "crm.sales-manager"), false, "narrowed to another CRM module");
    assert.equal(await canOpenModule(smA.id, "sales.lead-pipeline"), false, "no Sales Dashboard grant, and none needed");
  });
});

/* ══════════════════════════════════════════════════════════════ W — writes */

describe("W — a lead that is drawn can be acted on, and one that is not cannot", () => {
  test("a next action on a lead in the book persists — at the ASSOCIATE level the production account holds", async () => {
    const r = await setLeadNextAction(mineA.id, { action: "Send the price list", date: NEXT_WEEK, ownerId: salesman.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(mineA.id);
    assert.equal(after.leadNextAction, "Send the price list");
    assert.equal((await pipelineLead(mineA.id, DAY))!.lead.nextAction, "Send the price list");
  });

  test("a lead nobody owns, but whose Sales Manager is named, can be acted on too", async () => {
    const r = await setLeadNextAction(mineANoOwner.id, { action: "Ring the shop", date: NEXT_WEEK, ownerId: salesman.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  test("out-of-scope writes are rejected and change nothing: another manager's, owner-only, unassigned", async () => {
    for (const lead of [mineB, ownerOnly, unassigned]) {
      const r = await setLeadNextAction(lead.id, { action: "Should not land", date: NEXT_WEEK, ownerId: salesman.id });
      assert.equal(r.ok, false, `${lead.name} must be refused`);
      assert.equal((await row(lead.id)).leadNextAction, null, `${lead.name} was written to`);
    }
  });

  test("reassigning the owner works inside the book, keeps the lead in it, and is refused outside", async () => {
    const r = await reassignLead({ leadId: mineA.id, salesmanId: salesman2.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(mineA.id);
    assert.equal(after.ownerId, salesman2.id, "the assignment moved");
    assert.equal(after.salesManagerId, smA.id, "the Sales Manager seat did not");
    assert.ok((await listIds()).includes(mineA.id), "and the lead is still in this manager's book");

    for (const lead of [mineB, ownerOnly, unassigned]) {
      const bad = await reassignLead({ leadId: lead.id, salesmanId: salesman2.id });
      assert.equal(bad.ok, false, `${lead.name} must be refused`);
      assert.notEqual((await row(lead.id)).ownerId, salesman2.id);
    }
  });

  test("reassigning needs the CRM module — a CRM user without it is refused", async () => {
    setTestUser(noModule);
    const r = await reassignLead({ leadId: mineA.id, salesmanId: salesman2.id });
    assert.equal(r.ok, false);
    assert.equal((await row(mineA.id)).ownerId, salesman.id);
  });

  test("an administrator can act on any lead", async () => {
    setTestUser(admin);
    const r = await setLeadNextAction(unassigned.id, { action: "Assign and ring", date: NEXT_WEEK, ownerId: salesman.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  test("a manager-level Sales Manager verifies a prospect in their book — and not one outside it", async () => {
    const mine = await makeLead({
      leadStage: "prospect",
      ownerId: salesman.id,
      salesManagerId: smLead.id,
      ...prospectFields(),
      leadNextAction: "Manager verification call",
      leadNextActionDate: DAY,
      leadNextActionOwnerId: smLead.id,
    });
    const theirs = await makeLead({ leadStage: "prospect", ownerId: salesman.id, salesManagerId: smB.id, ...prospectFields() });
    setTestUser(smLead);

    const ok = await verifyProspect({
      customerId: mine.id,
      outcome: "verified",
      answers: { visited: "Yes", explained: "Yes", genuine_interest: "Yes", ready_for_trial: "Yes" },
      corrections: [],
    });
    assert.equal(ok.ok, true, ok.ok ? "" : ok.error);
    const after = await row(mine.id);
    assert.equal(after.leadVerifiedById, smLead.id);
    assert.equal(after.leadStage, "qualification");

    const refused = await verifyProspect({
      customerId: theirs.id,
      outcome: "verified",
      answers: { visited: "Yes", explained: "Yes", genuine_interest: "Yes", ready_for_trial: "Yes" },
      corrections: [],
    });
    assert.equal(refused.ok, false);
    assert.equal((await row(theirs.id)).leadStage, "prospect", "nothing moved");
  });

  test("the module does not grant the capability: an ASSOCIATE hat still cannot verify (reported, not changed)", async () => {
    /* `lead.verify` is a manager capability and this change adds no capability
       of its own. The screen draws what the level allows — the flag the record
       reports is the one the action checks — so an associate Sales Manager sees
       the control disabled rather than pressing it and being refused. */
    const mine = await makeLead({ leadStage: "prospect", ownerId: salesman.id, salesManagerId: smA.id, ...prospectFields() });
    const rec = (await pipelineLead(mine.id, DAY))!.lead;
    assert.equal(rec.caps.canVerify, false);

    const r = await verifyProspect({
      customerId: mine.id,
      outcome: "verified",
      answers: { visited: "Yes", explained: "Yes", genuine_interest: "Yes", ready_for_trial: "Yes" },
      corrections: [],
    });
    assert.equal(r.ok, false);
    assert.equal((await row(mine.id)).leadStage, "prospect");
  });
});

/* ═══════════════════════════════════════════════════ I — the salesman's lead */

describe("I — it is the salesman's lead, not a copy of it", () => {
  test("acting on a lead changes the row the handset reads and creates no second one", async () => {
    const before = await customerCount();
    const r = await setLeadNextAction(mineA.id, { action: "Visit again", date: NEXT_WEEK, ownerId: salesman.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const after = await row(mineA.id);
    assert.equal(after.ownerId, salesman.id, "still the salesman's lead");
    assert.equal(after.leadNextAction, "Visit again", "and the salesman's next action is the one the manager set");
    assert.equal(after.leadNextActionOwnerId, salesman.id);
    assert.equal(await customerCount(), before, "no duplicate record, no parallel data model");
  });

  test("the salesman's own view of the record still resolves — the workspace scope narrows the office, not the handset", async () => {
    setTestWorkspace(null);
    setTestUser(salesman);
    const mine = await row(mineA.id);
    assert.equal(mine.ownerId, salesman.id);
    assert.equal(mine.salesManagerId, smA.id, "the seat the manager reads through is written by nobody here");
  });
});

/* ═══════════════════════════════════════════════════════ X — nothing else moved */

describe("X — the scope is this workspace's, and only this workspace's", () => {
  test("outside the workspace the territory scope is what it was: a manager with no region row is national", async () => {
    setTestWorkspace(null);
    assert.deepEqual(
      await listIds(),
      [mineA.id, mineANoOwner.id, mineB.id, ownerOnly.id, unassigned.id].sort(),
      "the Sales Dashboard's scope is untouched — nothing here narrowed it",
    );
  });

  test("outside the workspace a write is still resolved by the level, not by the Sales Manager seat", async () => {
    setTestWorkspace(null);
    /* Manager Aye holds the seat on `mineA` and is an associate: outside this
       workspace the seat drives no scope, so the ordinary own-book rule refuses
       a lead the salesman owns. That is the existing behaviour and it stays. */
    const r = await setLeadNextAction(mineA.id, { action: "Outside the workspace", date: NEXT_WEEK, ownerId: salesman.id });
    assert.equal(r.ok, false);
    assert.equal((await row(mineA.id)).leadNextAction, null);
  });
});

/* ═══════════════════════════════════════════ V — the prototype's five views */

describe("V — the prototype's views read the same book, narrowed", () => {
  test("the sidebar's four counts are the scoped book's: all, mine, today and overdue", async () => {
    const c = await pipelineSidebar(DAY);
    assert.equal(c.all, 2, "Manager Aye's book is two leads — not the company's five");
    assert.equal(typeof c.mine, "number");
    assert.equal(typeof c.today, "number");
    assert.equal(typeof c.overdue, "number");

    setTestUser(admin);
    assert.equal((await pipelineSidebar(DAY)).all, 5, "an administrator's book is every lead");
  });

  test("Sales type, Owner and Priority narrow inside the book and never past it", async () => {
    await makeLead({ name: "Dist lead", salesManagerId: smA.id, ownerId: salesman2.id, leadSalesType: "distributor", leadPriority: "high" });
    await makeLead({ name: "Third lead", salesManagerId: smA.id, ownerId: salesman.id, leadSalesType: "third_party", leadPriority: "low" });
    await makeLead({ name: "Not mine", salesManagerId: smB.id, ownerId: salesman.id, leadSalesType: "distributor", leadPriority: "high" });

    const page = (o: Record<string, string>) => pipelineList(DAY, { q: "", stage: "", view: "", page: 1, ...o });
    const names = async (o: Record<string, string>) => (await page(o)).rows.map((r) => r.name).sort();

    /* The Distributors & Third-Party view is this filter, and only over MY book. */
    assert.deepEqual(await names({ salesType: "distributor,third_party" }), ["Dist lead", "Third lead"]);
    assert.deepEqual(await names({ salesType: "distributor" }), ["Dist lead"]);
    assert.deepEqual(await names({ owner: salesman2.id }), ["Dist lead"]);
    assert.deepEqual(await names({ priority: "high" }), ["Dist lead"], "Manager Bee's high-priority lead is not offered");
    assert.deepEqual(await names({ priority: "low" }), ["Third lead"]);
  });

  test("the pipeline draws ten bars, second order among them, and a lead standing on it is counted", async () => {
    await makeLead({ name: "Repeat", salesManagerId: smA.id, ownerId: salesman.id, leadStage: "second_order" });
    const funnel = await pipelineFunnel(DAY);
    assert.equal(funnel.direct.length, 10);
    assert.equal(funnel.direct.find((f) => f.stage === "second_order")?.count, 1);
  });

  test("the record carries the customer's email, and names a telecaller's logged call as the telecaller's", async () => {
    await db.update(customers).set({ email: "shop@example.test" }).where(eq(customers.id, mineA.id));
    await db.insert(timelineEvents).values({
      id: id("tle"),
      customerId: mineA.id,
      eventType: "telecaller_call",
      sourceApp: "crm",
      sourceRecordId: id("cal"),
      occurredAt: new Date(),
      actorUserId: noModule.id,
      summary: "Rang the shop",
    });
    const rec = (await pipelineLead(mineA.id, DAY))!;
    assert.equal(rec.lead.email, "shop@example.test");
    assert.equal(rec.lead.timeline.find((t) => t.title === "Rang the shop")?.kind, "caller");
  });

  test("the dashboard's focus rows say whether a commitment is on file", async () => {
    const dash = await pipelineDashboard(DAY);
    assert.ok(dash.focus.every((r) => typeof r.hasCommitment === "boolean"));
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * D — the Sales Manager desk: the book, grouped by the salesman who owns it
 * ════════════════════════════════════════════════════════════════════════ */

describe("D — the desk reads the same book, by salesman", () => {
  test("the desk is this manager's book — each lead carries its salesman, and an unowned one says so", async () => {
    const desk = await pipelineDesk(DAY);
    assert.deepEqual(desk.rows.map((r) => r.id).sort(), [mineA.id, mineANoOwner.id].sort());
    const a = desk.rows.find((r) => r.id === mineA.id)!;
    assert.equal(a.ownerId, salesman.id);
    assert.equal(a.owner, "Salesman One");
    assert.equal(desk.rows.find((r) => r.id === mineANoOwner.id)!.ownerId, null);

    setTestUser(admin);
    assert.equal((await pipelineDesk(DAY)).rows.length, 5, "an administrator's desk is every lead");
  });

  test("lost leads are counted and left off the desk, never silently dropped", async () => {
    await makeLead({ name: "Gone", salesManagerId: smA.id, ownerId: salesman.id, leadStage: "lost" });
    const desk = await pipelineDesk(DAY);
    assert.equal(desk.lostHidden, 1);
    assert.ok(!desk.rows.some((r) => r.name === "Gone"));
  });

  test("overdue and qualification-review queues are read off the lead's own facts", async () => {
    await db
      .update(customers)
      .set({ leadNextAction: "Call the owner", leadNextActionDate: YESTERDAY, leadNextActionOwnerId: salesman.id })
      .where(eq(customers.id, mineA.id));
    const review = await makeLead({
      name: "Awaiting review",
      salesManagerId: smA.id,
      ownerId: salesman.id,
      leadStage: "qualification",
      leadNextAction: QUAL_NEXT.review,
      leadNextActionDate: NEXT_WEEK,
    });
    const desk = await pipelineDesk(DAY);
    assert.ok(desk.rows.find((r) => r.id === mineA.id)!.queues.includes("overdue"));
    assert.ok(desk.rows.find((r) => r.id === review.id)!.queues.includes("review"));
    assert.ok(!desk.rows.find((r) => r.id === mineANoOwner.id)!.queues.includes("review"));
  });

  test("grouping is by salesman, the unowned come last, and a section's counts are its own", async () => {
    await makeLead({ name: "Two", salesManagerId: smA.id, ownerId: salesman2.id });
    const desk = await pipelineDesk(DAY);
    const groups = groupBySalesman(desk.rows, { view: "all", q: "", salesmanId: "" });
    assert.deepEqual(groups.map((g) => g.name), ["Salesman One", "Salesman Two", "No salesman yet"]);
    assert.equal(groups.at(-1)!.id, NO_SALESMAN);
    assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), desk.rows.length);
    const only = groupBySalesman(desk.rows, { view: "all", q: "", salesmanId: salesman2.id });
    assert.deepEqual(only.map((g) => g.name), ["Salesman Two"]);
    const searched = groupBySalesman(desk.rows, { view: "all", q: "salesman one", salesmanId: "" });
    assert.deepEqual(searched.flatMap((g) => g.rows.map((r) => r.id)), [mineA.id], "the search reads the salesman's name too");
  });

  test("a manager without lead.verify is told, in words, that Verify is off — and the grants are untouched", async () => {
    const prospect = await makeLead({ name: "A prospect", salesManagerId: smA.id, ownerId: salesman.id, leadStage: "prospect" });
    const asAssociate = (await pipelineLead(prospect.id, DAY))!.lead;
    assert.equal(asAssociate.caps.canVerify, false, "the production shape: an associate Sales Manager");
    const reasons = disabledReasons(asAssociate.caps, {
      stage: asAssociate.stage,
      lost: Boolean(asAssociate.lost),
      deskRequest: Boolean(asAssociate.deskRequest),
      verified: asAssociate.verification.done,
      sampleState: asAssociate.sample?.state ?? null,
      gateKind: asAssociate.gate.kind,
    });
    assert.ok(reasons.some((r) => /lead\.verify/.test(r)), reasons.join(" | "));

    const owned = await makeLead({ name: "Led prospect", salesManagerId: smLead.id, ownerId: salesman.id, leadStage: "prospect" });
    setTestUser(smLead);
    const asManager = (await pipelineLead(owned.id, DAY))!.lead;
    assert.equal(asManager.caps.canVerify, true);
    assert.ok(
      !disabledReasons(asManager.caps, {
        stage: asManager.stage,
        lost: false,
        deskRequest: false,
        verified: asManager.verification.done,
        sampleState: null,
        gateKind: asManager.gate.kind,
      }).some((r) => /lead\.verify/.test(r)),
    );
  });
});
