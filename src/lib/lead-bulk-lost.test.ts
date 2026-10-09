/**
 * All Leads → Change stage → Lost, over the real action.
 *
 * The screen's modal now collects a reason; these pin what the SERVER does with
 * what it sends, and that a loss made this way is reversed by the existing
 * reopen exactly like any other.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, leadStageTransitions, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { bulkAdvanceLeadStage } from "@/lib/actions/leads";
import { reopenSalesManagerLead } from "@/lib/actions/lead-reopen";
import { bulkStagePayload } from "@/lib/lead-bulk-stage";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let manager: typeof users.$inferSelect;

async function makeManager() {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name: "Sales Manager",
      email: `mgr-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: "manager",
      initials: "SM",
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role: "manager" });
  return row;
}

async function makeLead(stage: "suspect" | "prospect" = "prospect") {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      contactPerson: "Ganesh",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nashik",
      kind: "lead",
      leadStage: stage,
      leadSalesType: "direct",
      leadSource: "Website / Online Enquiry",
      ownerId: manager.id,
      leadManagerId: manager.id,
    })
    .returning();
  return row;
}

const rowOf = async (leadId: string) =>
  (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const transitionsOf = (leadId: string) =>
  db
    .select()
    .from(leadStageTransitions)
    .where(eq(leadStageTransitions.customerId, leadId))
    .orderBy(leadStageTransitions.at, leadStageTransitions.id);

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
  manager = await makeManager();
  setTestUser(manager);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("bulk Change stage → Lost", () => {
  test("a valid configured reason closes every lead, on the row and in the history", async () => {
    const a = await makeLead();
    const b = await makeLead();
    const r = await bulkAdvanceLeadStage(
      bulkStagePayload([a.id, b.id], "lost", "credit_terms", "  asked for 90 days "),
    );
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.data?.done, 2);
    assert.equal(r.ok && r.data?.failed.length, 0);
    for (const lead of [a, b]) {
      const now = await rowOf(lead.id);
      assert.equal(now.leadStage, "lost");
      assert.equal(now.leadLostReason, "credit_terms");
      const last = (await transitionsOf(lead.id)).at(-1)!;
      assert.equal(last.fromStage, "prospect");
      assert.equal(last.toStage, "lost");
      assert.equal(last.reasonCode, "credit_terms");
      assert.equal(last.note, "asked for 90 days");
    }
  });

  test("no reason, or a reason that is not configured, moves nothing and writes nothing", async () => {
    const a = await makeLead();
    for (const reasonCode of [undefined, "", "made_up"]) {
      const r = await bulkAdvanceLeadStage({ customerIds: [a.id], to: "lost", reasonCode });
      assert.equal(r.ok, true);
      assert.equal(r.ok && r.data?.done, 0);
      assert.equal(r.ok && r.data?.failed.length, 1);
      assert.match(r.ok ? (r.message ?? "") : "", /did not move/);
      assert.match(r.ok ? (r.data?.failed[0].why ?? "") : "", /A loss nobody explained/);
    }
    const now = await rowOf(a.id);
    assert.equal(now.leadStage, "prospect");
    assert.equal(now.leadLostReason, null);
    assert.equal((await transitionsOf(a.id)).length, 0);
  });

  test("a mixed batch reports who moved and who did not, and the refused one is untouched", async () => {
    const open = await makeLead();
    const alreadyLost = await makeLead();
    const first = await bulkAdvanceLeadStage(bulkStagePayload([alreadyLost.id], "lost", "price", ""));
    assert.equal(first.ok && first.data?.done, 1);

    const r = await bulkAdvanceLeadStage(
      bulkStagePayload([open.id, alreadyLost.id], "lost", "quality", ""),
    );
    assert.equal(r.ok && r.data?.done, 1);
    assert.deepEqual(r.ok && r.data?.failed.map((f) => f.id), [alreadyLost.id]);
    assert.match(r.ok ? (r.data?.failed[0].why ?? "") : "", /already at/i);

    assert.equal((await rowOf(open.id)).leadLostReason, "quality");
    /* The refused lead keeps its ORIGINAL reason and gains no second loss row. */
    assert.equal((await rowOf(alreadyLost.id)).leadLostReason, "price");
    assert.equal((await transitionsOf(alreadyLost.id)).length, 1);
  });

  test("a Lost lead stays Lost: a bulk move to another rung cannot undo it", async () => {
    const a = await makeLead();
    await bulkAdvanceLeadStage(bulkStagePayload([a.id], "lost", "price", ""));
    const r = await bulkAdvanceLeadStage({ customerIds: [a.id], to: "contacted" });
    assert.equal(r.ok && r.data?.done, 0);
    assert.equal((await rowOf(a.id)).leadStage, "lost");
    assert.equal((await transitionsOf(a.id)).length, 1);
  });
});

describe("a loss made in bulk is reversed by the existing reopen", () => {
  test("it returns to the rung it was lost from, and the loss stays in the history", async () => {
    const a = await makeLead("prospect");
    await bulkAdvanceLeadStage(bulkStagePayload([a.id], "lost", "price", ""));

    const r = await reopenSalesManagerLead({ customerId: a.id, reasonCode: "customer_responded" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const now = await rowOf(a.id);
    assert.equal(now.leadStage, "prospect");
    assert.equal(now.leadLostReason, null);

    const history = await transitionsOf(a.id);
    assert.deepEqual(
      history.map((t) => [t.fromStage, t.toStage]),
      [
        ["prospect", "lost"],
        ["lost", "prospect"],
      ],
    );
    /* The historical reason survives on the loss row though the row's own is cleared. */
    assert.equal(history[0].reasonCode, "price");
  });
});
