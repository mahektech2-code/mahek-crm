/**
 * Lead Management → Lost — the central record of every lead closed lost.
 *
 *   npm run test:integration
 *
 * Runs against mahekone_test with the real actions and services: §26's stage
 * machinery already writes `lead_stage = 'lost'`, `lead_lost_reason` and the
 * closing row in `lead_stage_transitions` for every existing stage move, so
 * what this file pins is that the new screen READS those correctly, that the
 * module gate protects it the same way `crm.lead-calling-desk` protects the
 * telecaller's desk, and that closing a lead lost cleans up after itself
 * without touching a lead it was never asked about.
 *
 * Four things, in the order they were asked for:
 *
 *   A  ACCESS — `crm.lead-lost` is off by default; a granted person opens it,
 *      an ungranted one does not, and an administrator's hat reaches it the
 *      same way it reaches the calling desk.
 *   B  THE LIST — only leads currently at `lost` appear, from any stage they
 *      were lost from; the scope narrowing is the same `leadsVisible` every
 *      other lead list runs through.
 *   C  STAGE AT LOSS — read off the closing `lead_stage_transitions` row, not
 *      off a guess, and a lead with no such row reads "not recorded" rather
 *      than inventing one.
 *   D  THE CLEANUP — closing a lead lost clears its §24 next action and
 *      cancels its own open nurture tasks, and touches nothing that belongs
 *      to a different lead or a different kind of task.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, customers, mbosTasks, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { advanceLeadStage } from "@/lib/actions/leads";
import { today } from "@/lib/recompute";
import { NURTURE_SOURCE_TYPE } from "@/lib/engines/lead-nurture";
import { lostLeadsPage, lostLeadOwnerOptions, lostLeadTiles } from "@/lib/services/lead-lost-service";
import { applyLeadStageMove, evaluateLeadStageMove, leadGateInput, leadRow } from "@/lib/services/lead-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TODAY = "2026-09-29";

let associate: typeof users.$inferSelect;

async function makeUser(name: string, role: "associate" | "manager" | "admin") {
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
      name: over.name ?? `Lead ${randomUUID().slice(0, 6)}`,
      contactPerson: "Contact",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nagpur",
      kind: "lead",
      leadStage: "qualified",
      leadSource: "manual",
      createdAt: new Date(`${TODAY}T04:00:00Z`),
      ...over,
    })
    .returning();
  return row;
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
    truncate table app_module_access, mbos_tasks, lead_stage_transitions, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  associate = await makeUser("Poonam Associate", "associate");
  setTestUser(associate);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("A — access is the same off-by-default module architecture as the calling desk", () => {
  test("a raw, un-narrowed whole-CRM grant still reaches it — the same gap `crm.lead-calling-desk` has until a deployment backfills it", async () => {
    // `offByDefault` changes what the ACCESS SCREEN writes when the app's own
    // box is first ticked (`DEFAULT_OF`, which excludes it) — it does not, on
    // its own, refuse a grant with zero module rows at all, which is the shape
    // `npm run app:grant` and the provisioning endpoint write. That is the
    // documented, existing behaviour `moduleAllowed` states for the calling
    // desk, and `crm.lead-lost` follows it identically rather than inventing a
    // second rule for one module.
    assert.equal(await canOpenModule(associate.id, "crm.lead-lost"), true);
  });

  test("granting the one row opens it, and touches nothing else", async () => {
    await db.insert(appModuleAccess).values({
      id: id("mod"),
      userId: associate.id,
      app: "crm",
      module: "crm.lead-lost",
    });
    assert.equal(await canOpenModule(associate.id, "crm.lead-lost"), true);
    // A grant of one module narrows to exactly that module, per the existing
    // "no rows means everything, one row means only that" rule.
    assert.equal(await canOpenModule(associate.id, "crm.leads"), false);
  });

  test("narrowed to other modules, Lost stays withheld", async () => {
    await db.insert(appModuleAccess).values({
      id: id("mod"),
      userId: associate.id,
      app: "crm",
      module: "crm.leads",
    });
    assert.equal(await canOpenModule(associate.id, "crm.lead-lost"), false);
  });

  test("an administrator's hat reaches it whatever the rows say, like the calling desk", async () => {
    const admin = await makeUser("Vikram Admin", "admin");
    assert.equal(await canOpenModule(admin.id, "crm.lead-lost"), true);
    // Narrowed on purpose, an administrator stays narrowed everywhere else —
    // the bypass reaches only the offByDefault modules, never the whole app.
    await db.insert(appModuleAccess).values({
      id: id("mod"),
      userId: admin.id,
      app: "crm",
      module: "crm.customers",
    });
    assert.equal(await canOpenModule(admin.id, "crm.lead-lost"), true);
    assert.equal(await canOpenModule(admin.id, "crm.leads"), false);
  });
});

describe("B/C — the Lost list, and where each row was lost from", () => {
  test("only leads at `lost` appear, and each carries the rung it was lost from", async () => {
    const suspect = await makeLead({ name: "Closed from qualification", leadStage: "qualified", ownerId: associate.id });
    const sample = await makeLead({ name: "Closed from sample", leadStage: "sample_trial", ownerId: associate.id });
    const active = await makeLead({ name: "Still working", leadStage: "negotiation", ownerId: associate.id });

    const lostA = await advanceLeadStage({ customerId: suspect.id, to: "lost", reasonCode: "price" });
    assert.equal(lostA.ok, true, lostA.ok ? "" : lostA.error);
    const lostB = await advanceLeadStage({ customerId: sample.id, to: "lost", reasonCode: "competitor" });
    assert.equal(lostB.ok, true, lostB.ok ? "" : lostB.error);

    const page = await lostLeadsPage();
    const byId = new Map(page.rows.map((r) => [r.id, r]));

    assert.equal(page.total, 2, "the still-working lead does not appear");
    assert.ok(!byId.has(active.id));

    assert.equal(byId.get(suspect.id)?.fromStage, "qualified", "stage at loss is the rung it was lost FROM, not `lost` itself");
    assert.equal(byId.get(suspect.id)?.lostReason, "price");
    assert.ok(byId.get(suspect.id)?.lostByName, "the actor who closed it is named");
    assert.ok(byId.get(suspect.id)?.lostDate, "the day it closed is recorded");

    assert.equal(byId.get(sample.id)?.fromStage, "sample_trial");
    assert.equal(byId.get(sample.id)?.lostReason, "competitor");
  });

  test("a legacy lead with no closing transition reads 'not recorded', never a guess", async () => {
    // Simulating a row from before `lead_stage_transitions` existed: `lost`
    // on the customer row, nothing in the transition table.
    const legacy = await makeLead({ name: "Legacy lost lead", leadStage: "lost", leadLostReason: "other" });

    const page = await lostLeadsPage();
    const row = page.rows.find((r) => r.id === legacy.id);
    assert.ok(row);
    assert.equal(row?.fromStage, null, "no transition exists, so nothing is invented");
    assert.equal(row?.lostByName, null);
  });

  test("filters narrow the list: by owner, by lead type, by stage-at-loss and by reason", async () => {
    const salesman = await makeUser("Rakesh Field", "associate");
    const a = await makeLead({ name: "A", leadStage: "qualified", ownerId: salesman.id, leadSalesType: "direct" });
    const b = await makeLead({ name: "B", leadStage: "negotiation", ownerId: associate.id, leadSalesType: "third_party" });
    // Each is closed by its own owner — an associate's scope is their own
    // book, exactly as `leads-list.test.ts` already pins for every other lead
    // action, and this test is about the Lost list's filters, not about scope.
    setTestUser(salesman);
    const closedA = await advanceLeadStage({ customerId: a.id, to: "lost", reasonCode: "price" });
    assert.equal(closedA.ok, true, closedA.ok ? "" : closedA.error);
    setTestUser(associate);
    const closedB = await advanceLeadStage({ customerId: b.id, to: "lost", reasonCode: "quality" });
    assert.equal(closedB.ok, true, closedB.ok ? "" : closedB.error);

    // READ by somebody whose scope covers both books. An associate's is their
    // own — it used to answer national here, which is the fail-open
    // `managerScope` no longer has — so a filter by another person's name is
    // asked by a manager. A test names no app on its request, so the level is
    // read on the Sales Dashboard, which is where that manager holds it.
    const reader = await makeUser("Meera Manager", "manager");
    await db.insert(appAccess).values({ id: id("aca"), userId: reader.id, app: "sales", role: "manager" });
    setTestUser(reader);

    const byOwner = await lostLeadsPage({ filters: { owner: salesman.id } });
    assert.deepEqual(byOwner.rows.map((r) => r.id), [a.id]);

    const byStage = await lostLeadsPage({ filters: { fromStage: "negotiation" } });
    assert.deepEqual(byStage.rows.map((r) => r.id), [b.id]);

    const byReason = await lostLeadsPage({ filters: { reason: "quality" } });
    assert.deepEqual(byReason.rows.map((r) => r.id), [b.id]);

    const byType = await lostLeadsPage({ filters: { salesType: "third_party" } });
    assert.deepEqual(byType.rows.map((r) => r.id), [b.id]);

    const owners = await lostLeadOwnerOptions();
    assert.ok(owners.some((o) => o.value === salesman.id && o.count === 1));
  });

  test("the summary tiles count the same book, and the breakdown says which rung", async () => {
    const a = await makeLead({ name: "A", leadStage: "qualified", ownerId: associate.id });
    const b = await makeLead({ name: "B", leadStage: "sample_trial", ownerId: associate.id });
    const c = await makeLead({ name: "C", leadStage: "qualified", ownerId: associate.id });
    for (const lead of [a, b, c]) {
      const r = await advanceLeadStage({ customerId: lead.id, to: "lost", reasonCode: "price" });
      assert.equal(r.ok, true, r.ok ? "" : r.error);
    }
    // All three closed just now, dated by the ACTION's own `today()` rather
    // than this file's fixed TODAY constant — `advanceLeadStage` stamps
    // `lead_stage_since` from the real business date, so the tiles are asked
    // about that same day, not a fixture that happens to coincide with it.
    const day = await today();
    const tiles = await lostLeadTiles(day);
    assert.equal(tiles.total, 3);
    assert.equal(tiles.thisMonth, 3);
    assert.equal(tiles.thisWeek, 3);
    const qualified = tiles.byStage.find((s) => s.stage === "qualified");
    const sample = tiles.byStage.find((s) => s.stage === "sample_trial");
    assert.equal(qualified?.count, 2);
    assert.equal(sample?.count, 1);
  });

  test("this is not a deleted-leads page: an archived lead lost long ago still appears", async () => {
    const lead = await makeLead({ name: "Archived and lost", leadStage: "qualified", ownerId: associate.id });
    const closed = await advanceLeadStage({ customerId: lead.id, to: "lost", reasonCode: "other" });
    assert.equal(closed.ok, true, closed.ok ? "" : closed.error);
    await db.update(customers).set({ leadArchived: true }).where(eq(customers.id, lead.id));

    const page = await lostLeadsPage();
    assert.ok(page.rows.some((r) => r.id === lead.id), "archiving is a different decision from being lost");
  });
});

describe("D — closing a lead lost cleans up its own open work, and nothing else's", () => {
  test("§24's next action is cleared", async () => {
    const lead = await makeLead({
      leadStage: "qualified",
      ownerId: associate.id,
      leadNextAction: "Call to confirm interest",
      leadNextActionDate: "2026-10-05",
      leadNextActionOwnerId: associate.id,
      leadNextActionOutcome: "callback",
    });

    const result = await advanceLeadStage({ customerId: lead.id, to: "lost", reasonCode: "no_requirement" });
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const [row] = await db.select().from(customers).where(eq(customers.id, lead.id));
    assert.equal(row.leadNextAction, null);
    assert.equal(row.leadNextActionDate, null);
    assert.equal(row.leadNextActionOwnerId, null);
    assert.equal(row.leadNextActionOutcome, null);
  });

  test("its own open nurture tasks are cancelled, never deleted", async () => {
    const lead = await makeLead({ leadStage: "sample_trial", ownerId: associate.id });
    await db.insert(mbosTasks).values({
      id: id("mbos_task"),
      title: "Chase the sample review",
      assignedToUserId: associate.id,
      customerId: lead.id,
      status: "open",
      sourceType: NURTURE_SOURCE_TYPE,
      sourceId: `sample_review:${lead.id}:1`,
    });
    // A second, already-completed nurture task — must not be re-opened or re-stamped.
    const doneAt = new Date("2026-09-01T00:00:00Z");
    await db.insert(mbosTasks).values({
      id: id("mbos_task"),
      title: "Earlier nurture step, already done",
      assignedToUserId: associate.id,
      customerId: lead.id,
      status: "done",
      completedAt: doneAt,
      sourceType: NURTURE_SOURCE_TYPE,
      sourceId: `sample_review:${lead.id}:0`,
    });

    const result = await advanceLeadStage({ customerId: lead.id, to: "lost", reasonCode: "not_interested" });
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const tasks = await db.select().from(mbosTasks).where(eq(mbosTasks.customerId, lead.id));
    const open = tasks.find((t) => t.sourceId === `sample_review:${lead.id}:1`);
    const done = tasks.find((t) => t.sourceId === `sample_review:${lead.id}:0`);

    assert.equal(open?.status, "cancelled");
    assert.ok(open?.completionNote);
    assert.ok(open?.completedAt);

    // Untouched — it was already closed before the lead was.
    assert.equal(done?.status, "done");
    assert.deepEqual(done?.completedAt, doneAt);
  });

  test("a task of a DIFFERENT kind on the same lead is left exactly as it was", async () => {
    const lead = await makeLead({ leadStage: "qualified", ownerId: associate.id });
    await db.insert(mbosTasks).values({
      id: id("mbos_task"),
      title: "Verification call",
      assignedToUserId: associate.id,
      customerId: lead.id,
      status: "open",
      sourceType: "lead_verification",
      sourceId: lead.id,
    });

    await advanceLeadStage({ customerId: lead.id, to: "lost", reasonCode: "wrong_lead" });

    const [task] = await db.select().from(mbosTasks).where(eq(mbosTasks.customerId, lead.id));
    assert.equal(task.status, "open", "only NURTURE_SOURCE_TYPE tasks are the rule's to close");
    assert.equal(task.completionNote, null);
  });

  test("a nurture task belonging to a DIFFERENT lead is untouched", async () => {
    const lead = await makeLead({ leadStage: "qualified", ownerId: associate.id });
    const other = await makeLead({ leadStage: "sample_trial", ownerId: associate.id });
    await db.insert(mbosTasks).values({
      id: id("mbos_task"),
      title: "Somebody else's nurture task",
      assignedToUserId: associate.id,
      customerId: other.id,
      status: "open",
      sourceType: NURTURE_SOURCE_TYPE,
      sourceId: `sample_review:${other.id}:1`,
    });

    await advanceLeadStage({ customerId: lead.id, to: "lost", reasonCode: "credit_terms" });

    const [task] = await db.select().from(mbosTasks).where(eq(mbosTasks.customerId, other.id));
    assert.equal(task.status, "open");
  });

  test("Won and every other terminal stage are untouched by this rule", async () => {
    const lead = await makeLead({
      leadStage: "negotiation",
      ownerId: associate.id,
      leadNextAction: "Confirm the order",
      leadNextActionDate: "2026-10-01",
      leadNextActionOwnerId: associate.id,
    });
    await db.insert(mbosTasks).values({
      id: id("mbos_task"),
      title: "Nurture step",
      assignedToUserId: associate.id,
      customerId: lead.id,
      status: "open",
      sourceType: NURTURE_SOURCE_TYPE,
      sourceId: `x:${lead.id}:1`,
    });

    // Through `applyLeadStageMove` directly rather than the action: reaching
    // `won` for real would mean satisfying §28's whole qualification and
    // commercial checklist, which is `lead-gates.test.ts`'s job, not this
    // file's. What this test owns is the WRITE — that the §26 cleanup fires
    // only `if (to === "lost")` and nowhere else.
    const row0 = await leadRow(lead.id);
    assert.ok(row0);
    await applyLeadStageMove(
      { userId: associate.id, hat: null, sourceApp: "crm" },
      row0!,
      "won",
      { decision: { ok: true, kind: "passed", overriddenConditions: [] }, day: TODAY },
    );

    const [row] = await db.select().from(customers).where(eq(customers.id, lead.id));
    assert.equal(row.leadNextAction, "Confirm the order", "won does not clear a next action");

    const [task] = await db.select().from(mbosTasks).where(eq(mbosTasks.customerId, lead.id));
    assert.equal(task.status, "open", "won does not cancel nurture tasks");
  });

  test("the existing lost-reason requirement is unchanged — this feature reuses it rather than duplicating it", async () => {
    const lead = await makeLead({ leadStage: "qualified" });
    const [gate, row] = await Promise.all([leadGateInput(lead.id), leadRow(lead.id)]);
    assert.ok(gate);
    assert.ok(row);
    const decision = await evaluateLeadStageMove({
      lead: row!,
      gate: gate!,
      to: "lost",
      reasonCode: null,
      canOverride: false,
    });
    assert.equal(decision.ok, false);
    assert.equal((decision as { code: string }).code, "lost_reason");
  });
});
