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
import { appAccess, appModuleAccess, customers, employeeReporting, employees, products, timelineEvents, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { captureLead } from "@/lib/actions/lead-intake";
import { recomputeSalesManagers } from "@/lib/recompute";
import { setLeadNextAction } from "@/lib/actions/leads";
import { reassignLead } from "@/lib/actions/sales";
import { verifyProspect } from "@/lib/actions/sales-manager-pipeline";
import { editLeadBasics } from "@/lib/actions/sales-manager-edit";
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

  test("an ASSOCIATE Sales Manager verifies a prospect under HER seat (and no other), without becoming a manager", async () => {
    /* This test used to pin the opposite ("reported, not changed"): the module
       granted no capability, so an associate Sales Manager saw the control
       disabled on her own lead. Verification now follows `sales_manager_id`
       (lead-verifier.ts): the seat plus the module is enough, and nothing else
       is granted — the same hat still cannot verify a lead under another seat. */
    const mine = await makeLead({ leadStage: "prospect", ownerId: salesman.id, salesManagerId: smA.id, ...prospectFields() });
    const other = await makeLead({ leadStage: "prospect", ownerId: salesman.id, salesManagerId: smB.id, ...prospectFields() });
    const rec = (await pipelineLead(mine.id, DAY))!.lead;
    assert.equal(rec.caps.canVerify, true, "the screen reflects the same rule the action enforces");
    assert.equal((await pipelineLead(other.id, DAY)) === null || (await pipelineLead(other.id, DAY))!.lead.caps.canVerify === false, true);

    const refused = await verifyProspect({
      customerId: other.id,
      outcome: "verified",
      answers: { visited: "Yes", explained: "Yes", genuine_interest: "Yes", ready_for_trial: "Yes" },
      corrections: [],
    });
    assert.equal(refused.ok, false);
    assert.equal((await row(other.id)).leadStage, "prospect", "another Sales Manager's lead did not move");

    const r = await verifyProspect({
      customerId: mine.id,
      outcome: "verified",
      answers: { visited: "Yes", explained: "Yes", genuine_interest: "Yes", ready_for_trial: "Yes" },
      corrections: [],
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(mine.id);
    assert.equal(after.leadVerifiedById, smA.id);
    assert.equal(after.leadStage, "qualification", "Qualification opens as before");
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
    /* A MANAGER of the Sales Dashboard — the app the territory rule belongs
       to, and the one a request naming no app is read against. No region row
       still means national for them; the seat narrowed nothing. */
    const salesBoss = await makeUser("Sales Boss", "manager", [{ app: "sales", role: "manager" }]);
    setTestUser(salesBoss);
    assert.deepEqual(
      await listIds(),
      [mineA.id, mineANoOwner.id, mineB.id, ownerOnly.id, unassigned.id].sort(),
      "the Sales Dashboard's scope is untouched — nothing here narrowed it",
    );
  });

  test("outside the workspace an ASSOCIATE holding the seat sees their own book, not the company's", async () => {
    setTestWorkspace(null);
    /* Manager Aye is a CRM associate. Outside this workspace the seat drives no
       scope, and the territory rule is a rule about MANAGERS — it used to
       answer national for anybody with no region row, which handed an
       associate every lead in the company. The level is read first now: their
       own book, plus the leads nobody owns, which `leadsVisible` shows to
       anybody who can open a lead list. `mineANoOwner` is here because it is
       unowned, not because Aye holds its seat. */
    assert.deepEqual(
      await listIds(),
      [mineANoOwner.id, unassigned.id].sort(),
      "an associate outside the workspace saw more than their own book",
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

  test("the Verify-is-off sentence is for somebody with neither the capability nor the seat — and the grants are untouched", async () => {
    const prospect = await makeLead({ name: "A prospect", salesManagerId: smA.id, ownerId: salesman.id, leadStage: "prospect" });
    const asAssociate = (await pipelineLead(prospect.id, DAY))!.lead;
    assert.equal(asAssociate.caps.canVerify, true, "the production shape: an associate Sales Manager under her own seat can verify");
    assert.ok(
      !disabledReasons(asAssociate.caps, {
        stage: asAssociate.stage,
        lost: Boolean(asAssociate.lost),
        deskRequest: Boolean(asAssociate.deskRequest),
        verified: asAssociate.verification.done,
        sampleState: asAssociate.sample?.state ?? null,
        gateKind: asAssociate.gate.kind,
      }).some((r) => /lead.verify/.test(r)),
    );
    const stripped = { ...asAssociate.caps, canVerify: false };
    const reasons = disabledReasons(stripped, {
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

/* ═══════════════════════════════════════════ R — a lead a Sales Manager raises */

describe("R — a Sales Manager who raises a lead is its Sales Manager, at once", () => {
  const capture = (over: Partial<Parameters<typeof captureLead>[0]> = {}) =>
    captureLead({
      salesType: "direct",
      name: `Raised ${randomUUID().slice(0, 6)}`,
      phone: String(9800000000 + Math.floor(Math.random() * 99999999)),
      city: "Nashik",
      source: "telecalling",
      ...over,
    });

  test("the seat is the creator, the decision is stamped, and the lead is in their book immediately", async () => {
    setTestUser(smA);
    const made = await capture();
    assert.ok(made.ok, made.ok ? "" : made.error);
    const lead = await row(made.data.customerId);

    assert.equal(lead.salesManagerId, smA.id);
    assert.ok(lead.salesManagerDecidedAt, "stamped as a person's choice");
    assert.equal(lead.ownerId, null, "the owner rule is unchanged: a manager raising a lead leaves it unowned");

    assert.ok((await listIds()).includes(lead.id), "listed straight away");
    assert.ok(await pipelineLead(lead.id, DAY), "the record opens");
    assert.ok(
      (await pipelineDesk(DAY)).rows.some((r) => r.id === lead.id),
      "the desk the search runs over has it",
    );

    setTestUser(smB);
    assert.ok(!(await listIds()).includes(lead.id), "another Sales Manager still cannot see it");
  });

  test("it is the CREATOR's seat even when an owner is named — never the owner's manager", async () => {
    setTestUser(smA);
    const made = await capture({ ownerId: salesman.id });
    assert.ok(made.ok, made.ok ? "" : made.error);
    const lead = await row(made.data.customerId);
    assert.equal(lead.ownerId, salesman.id);
    assert.equal(lead.salesManagerId, smA.id);
  });

  test("a Sales Manager at the manager level is seated the same way", async () => {
    setTestUser(smLead);
    const made = await capture();
    assert.ok(made.ok, made.ok ? "" : made.error);
    assert.equal((await row(made.data.customerId)).salesManagerId, smLead.id);
  });

  test("the nightly recompute does not wipe it", async () => {
    const [boss, underling] = await Promise.all(
      ["Org Boss", "Org Underling"].map(async (name, i) =>
        (
          await db
            .insert(employees)
            .values({ id: id("emp"), employeeCode: `R-${i}`, name, status: "active", rowNumber: 900 + i, raw: {}, rowHash: `r-${i}-${randomUUID()}` })
            .returning()
        )[0],
      ),
    );
    await db.insert(employeeReporting).values({ id: id("er"), employeeId: underling.id, managerId: boss.id });
    try {
      setTestUser(smA);
      const made = await capture();
      assert.ok(made.ok, made.ok ? "" : made.error);

      const changed = await recomputeSalesManagers();
      assert.ok(changed >= 1, "the pass ran over the book (the control below was blanked)");

      assert.equal((await row(made.data.customerId)).salesManagerId, smA.id, "still the creator's");
      assert.equal((await row(mineANoOwner.id)).salesManagerId, null, "control: an undecided seat WOULD have been blanked");
    } finally {
      await db.delete(employeeReporting);
      await db.delete(employees);
    }
  });

  test("a creator who is not a Sales Manager keeps exactly the old behaviour", async () => {
    setTestUser(noModule);
    const made = await capture();
    assert.ok(made.ok, made.ok ? "" : made.error);
    const lead = await row(made.data.customerId);
    assert.equal(lead.salesManagerId, null);
    assert.equal(lead.salesManagerDecidedAt, null);

    setTestUser(smA);
    assert.ok(!(await listIds()).includes(lead.id), "in nobody's Sales Manager book, as before");
  });

  test("an administrator is not seated either", async () => {
    setTestUser(admin);
    const made = await capture();
    assert.ok(made.ok, made.ok ? "" : made.error);
    const lead = await row(made.data.customerId);
    assert.equal(lead.salesManagerId, null);
    assert.equal(lead.salesManagerDecidedAt, null);
  });
});

/* ═══════════════════════════════════════════════════════════ Recently badge */

describe("Recently — raised within the last 7 calendar days, in IST", () => {
  /** A lead raised at this instant, in the Sales Manager's own book. */
  const raisedAt = (iso: string, name: string) =>
    makeLead({ name, ownerId: salesman.id, salesManagerId: smA.id, createdAt: new Date(iso) });
  const flags = async () => new Map((await pipelineDesk(DAY)).rows.map((r) => [r.name, r.isRecent]));

  test("today, yesterday and six days ago are Recently; seven days and older are not", async () => {
    // DAY is 2026-09-24; noon IST on each day, so only the date decides it.
    await raisedAt("2026-09-24T12:00:00+05:30", "age0");
    await raisedAt("2026-09-23T12:00:00+05:30", "age1");
    await raisedAt("2026-09-18T12:00:00+05:30", "age6");
    await raisedAt("2026-09-17T12:00:00+05:30", "age7");
    await raisedAt("2026-08-01T12:00:00+05:30", "age54");
    const f = await flags();
    assert.equal(f.get("age0"), true, "today");
    assert.equal(f.get("age1"), true, "yesterday");
    assert.equal(f.get("age6"), true, "six days ago");
    assert.equal(f.get("age7"), false, "seven days ago is the first day of the next Age bucket");
    assert.equal(f.get("age54"), false, "older");
  });

  test("the day is the IST day, not the UTC one", async () => {
    // 00:30 IST on the 18th is 19:00 UTC on the 17th. By IST it is six days old (Recently);
    // read as a UTC date it would be seven (not).
    await raisedAt("2026-09-17T19:00:00Z", "ist-edge-in");
    // 23:30 IST on the 17th is 18:00 UTC the same day: seven days old either way.
    await raisedAt("2026-09-17T18:00:00Z", "ist-edge-out");
    // 01:30 IST today is 20:00 UTC yesterday: today by IST.
    await raisedAt("2026-09-23T20:00:00Z", "ist-today");
    const f = await flags();
    assert.equal(f.get("ist-edge-in"), true);
    assert.equal(f.get("ist-edge-out"), false);
    assert.equal(f.get("ist-today"), true);
  });

  test("the record header and the list rows agree", async () => {
    const fresh = await raisedAt("2026-09-23T12:00:00+05:30", "rec-fresh");
    const old = await raisedAt("2026-09-10T12:00:00+05:30", "rec-old");
    assert.equal((await pipelineLead(fresh.id, DAY))!.lead.isRecent, true);
    assert.equal((await pipelineLead(old.id, DAY))!.lead.isRecent, false);
    const listed = new Map((await pipelineList(DAY, { q: "", stage: "", view: "", page: 1 })).rows.map((r) => [r.id, r.isRecent]));
    assert.equal(listed.get(fresh.id), true);
    assert.equal(listed.get(old.id), false);
  });
});

/* ═══════════════════════════════════════════════ E — the six-field Edit */

describe("E — the Sales Manager's Edit: six fields, inside the book, and nothing else", () => {
  const freshPhone = () => `98765${String(Math.floor(Math.random() * 99999)).padStart(5, "0")}`;
  const audits = async (leadId: string) =>
    (
      await db.execute<{ action: string }>(
        sql`select action from audit_log where entity_id = ${leadId} and action = 'lead.basics.edit'`,
      )
    ).length;

  const sixFields = (leadId: string, over: Partial<Parameters<typeof editLeadBasics>[0]> = {}) => ({
    customerId: leadId,
    ownerId: salesman2.id,
    leadManagerId: smLead.id,
    city: "Virar",
    contact: "Suresh Rane",
    phone: freshPhone(),
    productId,
    ...over,
  });

  test("an associate-level Sales Manager edits all six on their own lead, and nothing else moves", async () => {
    const before = await row(mineA.id);
    const input = sixFields(mineA.id);
    const r = await editLeadBasics(input);
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const after = await row(mineA.id);
    assert.equal(after.ownerId, salesman2.id, "owner");
    assert.equal(after.leadManagerId, smLead.id, "sales manager");
    assert.equal(after.city, "Virar", "city");
    assert.equal(after.contactPerson, "Suresh Rane", "contact");
    assert.equal(after.phone, input.phone, "phone");
    assert.equal(after.leadRequiredProductId, productId, "product");

    assert.equal(after.leadStage, before.leadStage, "stage is never touched");
    assert.equal(after.salesManagerId, smA.id, "the seat the scope reads is never touched");
    assert.equal(after.kind, before.kind);
    assert.equal(await audits(mineA.id), 1, "city and phone leave an audit row");
    assert.ok((await listIds()).includes(mineA.id), "and it is still in the book");
  });

  test("a lead outside the seat is refused and left exactly as it was", async () => {
    for (const lead of [mineB, ownerOnly, unassigned]) {
      const before = await row(lead.id);
      const r = await editLeadBasics(sixFields(lead.id));
      assert.equal(r.ok, false, `${lead.name} must be refused`);
      const after = await row(lead.id);
      assert.equal(after.city, before.city);
      assert.equal(after.phone, before.phone);
      assert.equal(after.ownerId, before.ownerId);
      assert.equal(after.leadManagerId, before.leadManagerId);
    }
  });

  test("an administrator can edit any lead", async () => {
    setTestUser(admin);
    const r = await editLeadBasics(sixFields(mineB.id, { ownerId: null, leadManagerId: null }));
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(mineB.id)).city, "Virar");
  });

  test("it is refused outside the workspace — a server action is a URL", async () => {
    setTestWorkspace(null);
    const r = await editLeadBasics(sixFields(mineA.id));
    assert.equal(r.ok, false);
    assert.equal((await row(mineA.id)).city, "Nashik", "unchanged");
  });

  test("a CRM user without the Sales Manager module cannot, even on a lead in a Sales Manager's book", async () => {
    setTestUser(noModule);
    const r = await editLeadBasics(sixFields(mineA.id));
    assert.equal(r.ok, false);
    assert.equal((await row(mineA.id)).city, "Nashik");
  });

  test("a phone already on the book is refused before anything is written", async () => {
    const taken = (await row(mineB.id)).phone!;
    const r = await editLeadBasics(sixFields(mineA.id, { phone: taken, city: "Pune" }));
    assert.equal(r.ok, false);
    assert.equal(r.ok ? "" : r.code, "duplicate");
    assert.equal((await row(mineA.id)).city, "Nashik", "the city did not slip in ahead of the refusal");
  });

  test("its own phone number is not a duplicate, and a malformed one is a validation error", async () => {
    const own = (await row(mineA.id)).phone!;
    const ok1 = await editLeadBasics(sixFields(mineA.id, { phone: own, ownerId: null, leadManagerId: null, city: "Virar" }));
    assert.equal(ok1.ok, true, ok1.ok ? "" : ok1.error);
    const bad = await editLeadBasics(sixFields(mineA.id, { phone: "12345" }));
    assert.equal(bad.ok, false);
  });

  test("saving what is already there changes nothing and writes no audit row", async () => {
    const lead = await row(mineA.id);
    const r = await editLeadBasics({
      customerId: lead.id,
      ownerId: lead.ownerId,
      leadManagerId: lead.leadManagerId,
      city: lead.city!,
      contact: lead.contactPerson,
      phone: lead.phone!,
      productId: lead.leadRequiredProductId,
    });
    assert.equal(r.ok, true);
    assert.equal(r.ok ? r.message : "", "Nothing to change.");
    assert.equal(await audits(lead.id), 0);
  });

  test("the product and the contact can be cleared", async () => {
    await db.update(customers).set({ leadRequiredProductId: productId, contactPerson: "Ganesh" }).where(eq(customers.id, mineA.id));
    const lead = await row(mineA.id);
    const r = await editLeadBasics({
      customerId: lead.id,
      ownerId: lead.ownerId,
      leadManagerId: null,
      city: lead.city!,
      contact: "",
      phone: lead.phone!,
      productId: null,
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(mineA.id);
    assert.equal(after.leadRequiredProductId, null);
    assert.equal(after.contactPerson, null);
  });

  test("a refused owner leaves the earlier fields saved and says so", async () => {
    // noModule holds no Salesman App, so `reassignLead` refuses them.
    const r = await editLeadBasics(sixFields(mineA.id, { ownerId: noModule.id, leadManagerId: null }));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /Already saved: .*city/);
    const after = await row(mineA.id);
    assert.equal(after.city, "Virar", "what was valid was kept");
    assert.equal(after.ownerId, salesman.id, "the owner did not move");
  });
});
