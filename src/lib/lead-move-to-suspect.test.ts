/**
 * MOVING A LEAD TO SUSPECT when it is still spelled the old way.
 *
 * A lead at the legacy `new` / `contacted` stage that has been given a funnel
 * sales type used to be refused: "Suspect is not a rung on this lead's ladder.
 * Change the sales type first" - the funnel ladders start at `suspect`, so the
 * old spelling read as off the ladder. That move is now allowed, and ONLY that
 * move: every other off-ladder move is still refused.
 *
 * Real actions against `mahekone_test`.
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
import type { LeadStage } from "@/lib/lead-labels";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let manager: typeof users.$inferSelect;
let associate: typeof users.$inferSelect;

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
      name: `Suresh Patil ${randomUUID().slice(0, 4)}`,
      contactPerson: "Suresh",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nashik",
      kind: "lead",
      leadStage: "new",
      leadSalesType: "direct",
      leadSource: "Website / Online Enquiry",
      ownerId: associate.id,
      leadManagerId: manager.id,
      ...over,
    })
    .returning();
  return row;
}

const rowOf = async (leadId: string) =>
  (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const transitionsOf = (leadId: string) =>
  db.select().from(leadStageTransitions).where(eq(leadStageTransitions.customerId, leadId));

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
  manager = await makeUser("Sales Manager", "manager");
  associate = await makeUser("Desk Caller", "associate");
  setTestUser(associate);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("a lead still at the old new / contacted stage can be moved to Suspect", () => {
  test("the failing case: a Direct lead at `new`, moved to Suspect from the bulk action", async () => {
    const lead = await makeLead({ leadStage: "new", leadSalesType: "direct" });
    const r = await bulkAdvanceLeadStage({ customerIds: [lead.id], to: "suspect" });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.data?.done, 1, r.ok ? r.message : "");
    assert.equal(r.ok && r.data?.failed.length, 0);
    assert.equal((await rowOf(lead.id)).leadStage, "suspect");
    const [t] = await transitionsOf(lead.id);
    assert.equal(t.fromStage, "new");
    assert.equal(t.toStage, "suspect");
  });

  test("the single-lead action does the same, from `contacted` on the Third-party ladder", async () => {
    const lead = await makeLead({ leadStage: "contacted", leadSalesType: "third_party" });
    const r = await advanceLeadStage({ customerId: lead.id, to: "suspect" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await rowOf(lead.id)).leadStage, "suspect");
  });
});

describe("everything else off the ladder is still refused", () => {
  const refused = async (over: Partial<typeof customers.$inferInsert>, to: LeadStage) => {
    const lead = await makeLead(over);
    const r = await advanceLeadStage({ customerId: lead.id, to });
    assert.equal(r.ok, false, `expected ${over.leadStage} → ${to} to be refused`);
    const now = await rowOf(lead.id);
    assert.equal(now.leadStage, over.leadStage, "the stage must not have moved");
    assert.equal((await transitionsOf(lead.id)).length, 0, "and nothing may be written");
    return r.ok ? "" : r.error;
  };

  test("a Lost lead is not moved to Suspect by this door - reopening is the way", async () => {
    const message = await refused({ leadStage: "lost", leadLostReason: "price" }, "suspect");
    assert.match(message, /not a rung on this lead's ladder/);
  });

  test("a legacy `new` lead cannot skip to any other rung of the new ladder", async () => {
    await refused({ leadStage: "new" }, "prospect");
    await refused({ leadStage: "contacted" }, "qualification");
  });

  test("the legacy rungs that carry real work (qualified, won) are not relabelled Suspect", async () => {
    await refused({ leadStage: "qualified" }, "suspect");
    await refused({ leadStage: "won" }, "suspect");
  });

  test("a lead with NO sales type is still on the legacy ladder, which has no Suspect", async () => {
    await refused({ leadStage: "new", leadSalesType: null }, "suspect");
  });

  test("walking a real funnel lead back down is still a manager's, with a reason", async () => {
    const message = await refused({ leadStage: "prospect" }, "suspect");
    assert.match(message, /manager/i);
  });
});
