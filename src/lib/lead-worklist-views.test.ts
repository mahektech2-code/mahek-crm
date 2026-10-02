/**
 * THE FOUR WORKLIST VIEWS — `decide`, `parked`, `unworked`, `handover`.
 *
 * Four lists that lived only on screens leaving the navigation (Suspect
 * decisions, On hold, Nobody is working these, Handovers) are now views of the
 * one lead list. What is pinned here is what makes that safe:
 *
 *   - each view holds exactly its population, from ONE definition;
 *   - the count on the desk line equals the list it opens;
 *   - the old screens' own readers still agree with the views (parity), so
 *     nothing was lost by moving the question;
 *   - the order is the order the old screen had;
 *   - `handover` is scoped by the account's SALES SEAT, as the old page was.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, mbosUserTerritories, mbosVisits, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { LEAD_VIEWS, VIEW_CHIPS, VIEW_TEXT, viewFromParam } from "@/lib/lead-views";
import { leadsPage } from "@/lib/services/sales-service";
import { leadWorklistCounts } from "@/lib/services/lead-views-service";
import { leadsWithoutNextAction } from "@/lib/services/lead-console-service";
import { outstandingHandovers } from "@/lib/services/lead-oversight-service";
import { pipelineList } from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const DAY = "2026-10-02";
const PAST = "2026-01-01";
const FUTURE = "2099-01-01";

let manager: typeof users.$inferSelect;
let owner: typeof users.$inferSelect;

async function makeUser(name: string, role: "associate" | "manager", extraApp?: "field") {
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
  if (extraApp) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: extraApp });
  return row;
}

async function makeLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      contactPerson: "Contact",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nagpur",
      region: "Maharashtra",
      kind: "lead",
      leadStage: "qualification",
      leadSalesType: "direct",
      leadSource: "manual",
      ownerId: owner.id,
      /* Planned, so a lead is not in `unworked` by accident of the fixture. */
      leadNextAction: "Ring",
      leadNextActionDate: FUTURE,
      leadNextActionOwnerId: owner.id,
      ...over,
    })
    .returning();
  return row;
}

async function visit(customerId: string, salesmanId: string, times: number) {
  for (let i = 0; i < times; i++) {
    await db.insert(mbosVisits).values({
      id: id("vis"),
      customerId,
      salesmanId,
      clientCreatedAt: new Date(),
      checkInAt: new Date(),
    } as typeof mbosVisits.$inferInsert);
  }
}

const idsOf = async (view: "decide" | "parked" | "unworked" | "handover") =>
  (await leadsPage(DAY, { view, perPage: 200 })).rows.map((r) => r.id);

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_stage_transitions, mbos_visits, mbos_user_territories, mbos_tasks, notifications,
      timeline_events, audit_log, app_module_access, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  manager = await makeUser("Sales Manager", "manager");
  owner = await makeUser("Field Owner", "associate", "field");
  setTestUser(manager);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("the vocabulary", () => {
  test("the four are real views, are offered as chips, and say what they are", () => {
    for (const v of ["decide", "parked", "unworked", "handover"] as const) {
      assert.ok((LEAD_VIEWS as readonly string[]).includes(v), v);
      assert.ok((VIEW_CHIPS as readonly string[]).includes(v), `${v} is a chip`);
      assert.equal(viewFromParam(v), v);
      assert.ok(VIEW_TEXT[v].title.length > 3 && VIEW_TEXT[v].subtitle.length > 20, v);
    }
    assert.equal(viewFromParam("nonsense"), "all", "an unknown view is the whole book, never a throw");
  });
});

describe("decide — suspects out of visits, still undecided", () => {
  test("only suspects at or past the warning threshold, and not once decided", async () => {
    const warm = await makeLead({ leadStage: "suspect" });
    const cold = await makeLead({ leadStage: "suspect" });
    const decided = await makeLead({ leadStage: "suspect", leadSuspectDecidedAt: new Date() });
    const contacted = await makeLead({ leadStage: "contacted" });
    const qualified = await makeLead({ leadStage: "qualification" });
    await visit(warm.id, owner.id, 2); // the default threshold
    await visit(cold.id, owner.id, 1);
    await visit(decided.id, owner.id, 3);
    await visit(contacted.id, owner.id, 2);
    await visit(qualified.id, owner.id, 5);

    const got = (await idsOf("decide")).sort();
    assert.deepEqual(got, [warm.id, contacted.id].sort());
    assert.equal((await leadWorklistCounts(DAY)).decide, 2, "the count is the list");
  });
});

describe("parked — in the order the old screen read", () => {
  test("every park, undated first, then by the day each comes back", async () => {
    const later = await makeLead({ leadStage: "on_hold", leadHoldResumeDate: "2026-12-10" });
    const sooner = await makeLead({ leadStage: "on_hold", leadHoldResumeDate: "2026-11-01" });
    const undated = await makeLead({ leadStage: "on_hold", leadHoldResumeDate: null });
    await makeLead({ leadStage: "qualification" });

    const got = await idsOf("parked");
    assert.deepEqual(got, [undated.id, sooner.id, later.id]);
    assert.equal((await leadWorklistCounts(DAY)).parked, 3);
  });
});

describe("unworked — §24's exception, one definition", () => {
  test("no plan, or a plan whose day has gone unanswered; and the old screen agrees", async () => {
    const noPlan = await makeLead({ leadNextAction: null, leadNextActionDate: null, leadNextActionOwnerId: null });
    const gone = await makeLead({ leadNextActionDate: PAST, leadNextActionOutcome: null });
    await makeLead({ leadNextActionDate: PAST, leadNextActionOutcome: "They said they would call" });
    await makeLead(); // a full plan in the future
    await makeLead({
      leadStage: "lost",
      leadNextAction: null,
      leadNextActionDate: null,
      leadNextActionOwnerId: null,
    }); // terminal: nobody is waiting on it

    const got = await idsOf("unworked");
    assert.deepEqual(got, [noPlan.id, gone.id], "no plan at all comes first");
    assert.equal((await leadWorklistCounts(DAY)).unworked, 2);

    const old = await leadsWithoutNextAction(DAY);
    assert.equal(old.total, got.length, "the screen this replaces counts the same population");
    assert.deepEqual(old.rows.map((r) => r.customerId).sort(), [...got].sort());
  });
});

describe("handover — converted, nobody named, scoped by the sales seat", () => {
  test("converted and not yet handed over, longest-waiting first; and the old screen agrees", async () => {
    const waited = await makeLead({
      kind: "customer",
      leadStage: "second_order",
      leadConvertedAt: new Date("2026-08-01T00:00:00Z"),
      salesAmId: owner.id,
    });
    const recent = await makeLead({
      kind: "customer",
      leadStage: "second_order",
      leadConvertedAt: new Date("2026-09-20T00:00:00Z"),
      salesAmId: owner.id,
    });
    await makeLead({
      kind: "customer",
      leadStage: "second_order",
      leadConvertedAt: new Date("2026-08-05T00:00:00Z"),
      salesAmId: owner.id,
      handedOverAt: new Date(),
    });
    await makeLead(); // an ordinary lead

    assert.deepEqual(await idsOf("handover"), [waited.id, recent.id]);
    assert.equal((await leadWorklistCounts(DAY)).handover, 2);

    const old = await outstandingHandovers();
    assert.equal(old.total, 2);
    assert.deepEqual(old.rows.map((r) => r.customerId).sort(), [waited.id, recent.id].sort());
  });

  test("a regional manager sees the account whose SALES SEAT is in their region, whoever the lead's owner was", async () => {
    const regional = await makeUser("Regional Manager", "manager");
    await db.insert(mbosUserTerritories).values({
      id: id("ut"),
      userId: regional.id,
      kind: "region",
      region: "Maharashtra",
    });
    const inRegion = await makeUser("Salesman In", "associate", "field");
    const outRegion = await makeUser("Salesman Out", "associate", "field");
    // Each salesman is placed by where their book is.
    await makeLead({ ownerId: inRegion.id, region: "Maharashtra" });
    await makeLead({ ownerId: outRegion.id, region: "Gujarat" });

    // The owner was out of region; the account's sales seat is in it.
    const byseat = await makeLead({
      kind: "customer",
      leadStage: "second_order",
      leadConvertedAt: new Date("2026-08-01T00:00:00Z"),
      ownerId: outRegion.id,
      salesAmId: inRegion.id,
      region: "Maharashtra",
    });
    // The owner was in region; the sales seat is out of it.
    const byOwnerOnly = await makeLead({
      kind: "customer",
      leadStage: "second_order",
      leadConvertedAt: new Date("2026-08-02T00:00:00Z"),
      ownerId: inRegion.id,
      salesAmId: outRegion.id,
      amDecidedAt: new Date(),
      region: "Gujarat",
    });

    setTestUser(regional);
    const old = await outstandingHandovers();
    const got = await idsOf("handover");
    assert.ok(got.includes(byseat.id), "the sales seat decides whose book it is");
    assert.ok(!got.includes(byOwnerOnly.id), "the lead's old owner no longer does");
    assert.deepEqual(
      [...got].sort(),
      old.rows.map((r) => r.customerId).sort(),
      "the view and the Handovers screen show this manager the same accounts",
    );
    assert.equal((await leadWorklistCounts(DAY)).handover, got.length);
  });
});

describe("scope — a view only ever removes rows", () => {
  test("a regional manager sees the parked leads of salesmen in their region and not another's", async () => {
    const regional = await makeUser("Regional Manager", "manager");
    await db.insert(mbosUserTerritories).values({
      id: id("ut"),
      userId: regional.id,
      kind: "region",
      region: "Maharashtra",
    });
    const inRegion = await makeUser("Salesman In", "associate", "field");
    const outRegion = await makeUser("Salesman Out", "associate", "field");
    await makeLead({ ownerId: inRegion.id, region: "Maharashtra" });
    await makeLead({ ownerId: outRegion.id, region: "Gujarat" });
    const mine = await makeLead({ ownerId: inRegion.id, leadStage: "on_hold", region: "Maharashtra" });
    const theirs = await makeLead({ ownerId: outRegion.id, leadStage: "on_hold", region: "Gujarat" });

    setTestUser(regional);
    const got = await idsOf("parked");
    assert.ok(got.includes(mine.id));
    assert.ok(!got.includes(theirs.id));
    assert.equal((await leadWorklistCounts(DAY)).parked, got.length);
  });
});

describe("the Sales Manager's list", () => {
  test("accepts the three worklists it can answer, and reads each as the same population", async () => {
    const parked = await makeLead({ leadStage: "on_hold", leadHoldResumeDate: "2026-12-10" });
    const noPlan = await makeLead({ leadNextAction: null, leadNextActionDate: null, leadNextActionOwnerId: null });
    const warm = await makeLead({ leadStage: "suspect" });
    await visit(warm.id, owner.id, 2);
    await makeLead();

    for (const [view, want] of [
      ["parked", parked.id],
      ["unworked", noPlan.id],
      ["decide", warm.id],
    ] as const) {
      const list = await pipelineList(DAY, { view });
      assert.ok(list.rows.some((r) => r.id === want), `${view} reaches its lead`);
      assert.deepEqual(
        list.rows.map((r) => r.id).sort(),
        (await idsOf(view)).sort(),
        `${view}: the Sales Manager list and All Leads read one population`,
      );
    }
  });

  test("handover is not offered there — that seat is released at conversion, so it would read as empty", async () => {
    await makeLead({
      kind: "customer",
      leadStage: "second_order",
      leadConvertedAt: new Date("2026-08-01T00:00:00Z"),
      salesAmId: owner.id,
    });
    const asked = await pipelineList(DAY, { view: "handover" });
    const whole = await pipelineList(DAY, {});
    // An unrecognised view is the whole book, never an empty list posing as "nothing waiting".
    assert.equal(asked.total, whole.total);
  });
});

describe("nothing was moved by moving the question", () => {
  test("the old readers still answer on their own", async () => {
    await makeLead({ leadNextAction: null, leadNextActionDate: null, leadNextActionOwnerId: null });
    assert.equal((await leadsWithoutNextAction(DAY)).total, 1);
    assert.equal((await outstandingHandovers()).total, 0);
    const [row] = await db.select().from(customers).where(eq(customers.leadStage, "qualification")).limit(1);
    assert.ok(row);
  });
});
