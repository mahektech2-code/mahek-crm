/**
 * THE HANDSET'S LEAD WRITES, judged against the row they land on.
 *
 * Five things the sync handlers used to get wrong, each driven through
 * `ingestSyncBatch` — the door the phone actually uses:
 *
 *   1. A repeat field order on a converted customer re-ran the conversion,
 *      because it read `lead_stage` (which stays `won`) rather than `kind`.
 *   2. A lead update or a lead create could name ANY customers row by id.
 *   3. A visit's Suspect answer wrote the rung straight onto the row — no gate,
 *      no transition, no check the lead was still an undecided Suspect.
 *   4. Putting a lead On hold from the handset never wrote the stage.
 *   5. A refused move off a hold wiped the hold's reason before the gate spoke.
 *
 * And four about the shape of a field day, beside them because they go
 * through the same door:
 *
 *   6. Work done before a shop was reassigned away from him was refused for
 *      ever, because scope was asked as of the sync rather than the work.
 *   7. A visit naming no stop left the stop it plainly was counted as missed.
 *   8. Nothing on the phone could skip a stop.
 *   9. A day he planned that clashed with an office proposal was refused, and
 *      the shops he picked for it retried for ever.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  auditLog,
  customerAmChanges,
  customers,
  mbosDeletions,
  mbosJourneyPlans,
  mbosJourneyStops,
  mbosVisits,
  leadStageTransitions,
  mbosDevices,
  mbosUserTerritories,
  notifications,
  products,
  users,
} from "@/db/schema";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import type { MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";
import { testPhone } from "@/lib/test-phone";
import { addDays, calendarDate } from "@/lib/business-date";
import { today } from "@/lib/recompute";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/** Nagpur, Sadar. The shops are pinned here and every visit checks in on it. */
const SHOP = { lat: 21.1601, lng: 79.0805 };

let salesman: typeof users.$inferSelect;
let other: typeof users.$inferSelect;
let manager: typeof users.$inferSelect;
let principal: MbosPrincipal;
let sku: string;

async function makeUser(name: string, role: "associate" | "manager") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  return row!;
}

function item(over: Partial<SyncItem> & Pick<SyncItem, "entityType" | "payload">): SyncItem {
  const entityId = over.entityId ?? id("mbos");
  return {
    queueId: id("q"),
    entityId,
    op: "create",
    idempotencyKey: `${entityId}:${over.op ?? "create"}:${randomUUID()}`,
    clientCreatedAt: Date.now(),
    ...over,
  };
}

async function makeLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("lead"),
      name: "Shree Ganesh Paints",
      phone: testPhone(),
      city: "Nagpur",
      territoryRegion: "Maharashtra",
      kind: "lead",
      leadSalesType: "direct",
      leadStage: "suspect",
      leadStageSince: "2026-11-01",
      ownerId: salesman.id,
      gpsLat: SHOP.lat,
      gpsLng: SHOP.lng,
      ...over,
    })
    .returning();
  return row!;
}

const stored = async (customerId: string) =>
  (await db.select().from(customers).where(eq(customers.id, customerId)))[0]!;

const transitionsTo = async (customerId: string, to: string) =>
  db
    .select()
    .from(leadStageTransitions)
    .where(and(eq(leadStageTransitions.customerId, customerId), sql`${leadStageTransitions.toStage}::text = ${to}`));

async function visit(customerId: string, extra: Record<string, unknown> = {}) {
  const entityId = id("visit");
  const [result] = await ingestSyncBatch(principal, [
    item({
      entityType: "visit",
      entityId,
      payload: {
        customerId,
        checkInAt: Date.now() - 10 * 60_000,
        checkOutAt: Date.now(),
        checkInLat: SHOP.lat,
        checkInLng: SHOP.lng,
        checkInAccuracyM: 12,
        outcome: "visited",
        notes: "Spoke to the owner about the thinner they use.",
        ...extra,
      },
    }),
  ]);
  return result!;
}

const leadUpdate = (leadId: string, payload: Record<string, unknown>) =>
  item({ entityType: "lead", entityId: leadId, op: "update", payload });

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/);
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      orders, bills, lead_stage_transitions, mbos_visits, mbos_devices,
      mbos_journey_stops, mbos_journey_plans, customer_am_changes,
      mbos_sync_receipts, mbos_user_territories, mbos_deletions, timeline_events,
      audit_log, notifications, app_access, sessions, customers, users,
      app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  salesman = await makeUser("Mahesh", "associate");
  other = await makeUser("Rahul", "associate");
  manager = await makeUser("Vikram", "manager");
  await db.insert(appAccess).values([
    { id: id("aa"), userId: salesman.id, app: "field" },
    { id: id("aa"), userId: other.id, app: "field" },
    { id: id("aa"), userId: manager.id, app: "sales", role: "manager" },
  ]);
  await db.insert(mbosUserTerritories).values({
    id: id("ut"),
    userId: salesman.id,
    kind: "state",
    region: "Maharashtra",
  });
  await db
    .insert(mbosDevices)
    .values({ id: id("dev"), userId: salesman.id, deviceId: "probe-device", active: true });

  const [made] = await db
    .insert(products)
    .values({
      id: id("prd"),
      name: `Nano Thinner 5 L ${randomUUID().slice(0, 6)}`,
      packing: "Loose",
      millilitresPerCan: 5000,
      cansPerBox: 1,
    })
    .returning({ id: products.id });
  sku = made!.id;

  principal = {
    user: salesman,
    deviceId: "probe-device",
    role: "associate",
    scope: { kind: "own", userIds: [salesman.id] },
  } as MbosPrincipal;
});

after(async () => {
  await db.$client.end();
});

describe("1. A repeat field order on a converted customer converts nothing", () => {
  test("the sales seat, the customer-since date and the conversion stay as they were", async () => {
    /* A converted account: `kind = customer` with the rung it was won on kept,
       its sales seat decided by accounts and not the salesman's, and our
       salesman on it as back office so it is in his book. */
    const shopId = id("cus");
    const convertedAt = new Date("2026-03-01T06:00:00Z");
    await db.insert(customers).values({
      id: shopId,
      name: "Sai Paint Depot",
      phone: testPhone(),
      city: "Nagpur",
      territoryRegion: "Maharashtra",
      kind: "customer",
      leadStage: "won",
      ownerId: salesman.id,
      salesAmId: other.id,
      backOfficeAmId: salesman.id,
      amDecidedAt: new Date("2026-04-01T06:00:00Z"),
      customerSince: "2026-03-01",
      leadConvertedAt: convertedAt,
    });

    for (let n = 0; n < 2; n++) {
      const orderId = `mbos_order_${randomUUID()}`;
      const [r] = await ingestSyncBatch(principal, [
        item({
          entityType: "order",
          entityId: orderId,
          payload: {
            id: orderId,
            customerId: shopId,
            orderedAt: Date.now(),
            totalAmountPaise: 0,
            lines: [{ productId: sku, quantityCans: 4 }],
          },
        }),
      ]);
      assert.equal(r!.status, "accepted", JSON.stringify(r));
    }

    const after = await stored(shopId);
    assert.equal(after.salesAmId, other.id, "a decided sales seat is not rewritten from owner_id");
    assert.equal(after.customerSince, "2026-03-01");
    assert.equal(after.leadConvertedAt?.getTime(), convertedAt.getTime());
    assert.equal(after.kind, "customer");
  });
});

describe("2. A handset may write only a lead that is its own", () => {
  test("an update to another salesman's lead is refused, and nothing is written", async () => {
    const theirs = await makeLead({ ownerId: other.id, name: "Rahul's Shop" });
    const [r] = await ingestSyncBatch(principal, [
      leadUpdate(theirs.id, { name: "Hijacked", notes: "mine now" }),
    ]);
    assert.equal(r!.status, "rejected", JSON.stringify(r));
    const after = await stored(theirs.id);
    assert.equal(after.name, "Rahul's Shop");
    assert.equal(after.leadNotes, null);
  });

  test("a lead update naming a billed customer is refused as not a lead", async () => {
    const shop = await makeLead({ kind: "customer", leadStage: "won", salesAmId: salesman.id, name: "Billed Co" });
    const [r] = await ingestSyncBatch(principal, [leadUpdate(shop.id, { name: "Renamed" })]);
    assert.equal(r!.status, "rejected", JSON.stringify(r));
    assert.equal((await stored(shop.id)).name, "Billed Co");
  });

  test("a lead create naming another salesman's existing lead does not overwrite it", async () => {
    const theirs = await makeLead({ ownerId: other.id, name: "Rahul's Shop" });
    const [r] = await ingestSyncBatch(principal, [
      item({
        entityType: "lead",
        entityId: theirs.id,
        payload: { name: "Overwritten", mobile: testPhone(), city: "Nagpur", salesType: "direct", stage: "suspect" },
      }),
    ]);
    assert.equal(r!.status, "rejected", JSON.stringify(r));
    assert.equal((await stored(theirs.id)).name, "Rahul's Shop");
  });

  test("his own lead still updates", async () => {
    const mine = await makeLead();
    const [r] = await ingestSyncBatch(principal, [leadUpdate(mine.id, { notes: "Owner back Monday." })]);
    assert.equal(r!.status, "accepted", JSON.stringify(r));
    assert.equal((await stored(mine.id)).leadNotes, "Owner back Monday.");
  });
});

describe("3. A visit's Suspect answer moves the lead only through the gate", () => {
  test("'a prospect' without the seven answers keeps the visit, keeps the Suspect, and tells a manager", async () => {
    const lead = await makeLead();
    const r = await visit(lead.id, { suspectDecision: "qualified" });
    assert.equal(r.status, "accepted", JSON.stringify(r));

    const after = await stored(lead.id);
    assert.equal(after.leadStage, "suspect", "the gate refused, so the rung did not move");
    assert.equal((await transitionsTo(lead.id, "prospect")).length, 0);
    const told = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, manager.id), eq(notifications.title, "A Suspect decision was not applied")));
    assert.equal(told.length, 1);
  });

  test("'not a prospect' closes an undecided Suspect with a transition and the salesman's reason", async () => {
    const lead = await makeLead();
    const r = await visit(lead.id, { suspectDecision: "lost", suspectReason: "Buys only from the dealer next door." });
    assert.equal(r.status, "accepted", JSON.stringify(r));
    const after = await stored(lead.id);
    assert.equal(after.leadStage, "lost");
    assert.equal(after.leadLostReason, "Buys only from the dealer next door.");
    assert.equal((await transitionsTo(lead.id, "lost")).length, 1);
  });

  test("a late 'lost' never overwrites a lead that has moved past Suspect", async () => {
    const lead = await makeLead({ leadStage: "negotiation" });
    const r = await visit(lead.id, { suspectDecision: "lost", suspectReason: "Gone quiet." });
    assert.equal(r.status, "accepted", JSON.stringify(r));
    assert.equal((await stored(lead.id)).leadStage, "negotiation");
    assert.equal((await transitionsTo(lead.id, "lost")).length, 0);
  });

  test("a third-party shop is never decided by a visit", async () => {
    const shop = await makeLead({ thirdParty: true });
    const r = await visit(shop.id, { suspectDecision: "lost", suspectReason: "n/a" });
    assert.equal(r.status, "accepted", JSON.stringify(r));
    assert.equal((await stored(shop.id)).leadStage, "suspect");
  });
});

describe("4. On hold from the handset is a real park", () => {
  test("it writes the stage, its date, a transition row and the hold's own columns", async () => {
    const lead = await makeLead();
    const [r] = await ingestSyncBatch(principal, [
      leadUpdate(lead.id, {
        stage: "on_hold",
        holdReason: "Plant shut until Diwali.",
        reasonCode: "plant_shutdown",
        holdResumeDate: "2026-12-01",
      }),
    ]);
    assert.equal(r!.status, "accepted", JSON.stringify(r));
    const after = await stored(lead.id);
    assert.equal(after.leadStage, "on_hold");
    assert.notEqual(after.leadStageSince, "2026-11-01");
    assert.equal(after.leadHoldReason, "Plant shut until Diwali.");
    assert.equal(after.leadHoldReasonCode, "plant_shutdown");
    assert.equal(after.leadHoldResumeDate, "2026-12-01");
    assert.equal((await transitionsTo(lead.id, "on_hold")).length, 1);
  });

  test("a lead that has ended is not parked, and carries no hold afterwards", async () => {
    const lead = await makeLead({ leadStage: "lost", leadLostReason: "price" });
    const [r] = await ingestSyncBatch(principal, [
      leadUpdate(lead.id, { stage: "on_hold", holdReason: "Maybe later." }),
    ]);
    assert.equal(r!.status, "rejected", JSON.stringify(r));
    const after = await stored(lead.id);
    assert.equal(after.leadStage, "lost");
    assert.equal(after.leadHoldReason, null);
  });
});

describe("5. A refused move off a hold keeps the hold", () => {
  test("the reason, the code and the resume date survive the gate saying no", async () => {
    const lead = await makeLead({
      leadStage: "on_hold",
      leadHoldReason: "Budget quarter.",
      leadHoldReasonCode: "budget",
      leadHoldResumeDate: "2027-01-05",
    });
    const [r] = await ingestSyncBatch(principal, [leadUpdate(lead.id, { stage: "negotiation" })]);
    assert.equal(r!.status, "rejected", JSON.stringify(r));
    const after = await stored(lead.id);
    assert.equal(after.leadStage, "on_hold");
    assert.equal(after.leadHoldReason, "Budget quarter.");
    assert.equal(after.leadHoldReasonCode, "budget");
    assert.equal(after.leadHoldResumeDate, "2027-01-05");
  });
});

/* ══════════════════════════════════════════════════ the shape of a field day */

/** A customer in RAHUL's book now — not Mahesh's. */
async function rahulsShop() {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: "Laxmi Hardware",
      phone: testPhone(),
      city: "Nagpur",
      territoryRegion: "Maharashtra",
      kind: "customer",
      ownerId: other.id,
      salesAmId: other.id,
      gpsLat: SHOP.lat,
      gpsLng: SHOP.lng,
    })
    .returning();
  return row!;
}

/** The record that the shop moved from Mahesh to Rahul, at `at`. */
async function movedAway(customerId: string, at: Date) {
  await db.insert(customerAmChanges).values({
    id: id("amc"),
    customerId,
    role: "sales",
    fromUserId: salesman.id,
    fromName: salesman.name,
    toUserId: other.id,
    toName: other.name,
    reasonCode: "other",
    note: "Territory split.",
    changedById: manager.id,
    changedAt: at,
  });
}

describe("6. Work done before a reassignment lands, and the new holder is told", () => {
  test("a visit checked in before the move is accepted, audited and announced", async () => {
    const shop = await rahulsShop();
    await movedAway(shop.id, new Date());
    /* Checked in an hour before the desk moved the shop. */
    const r = await visit(shop.id, { checkInAt: Date.now() - 60 * 60_000, checkOutAt: Date.now() - 45 * 60_000 });
    assert.equal(r.status, "accepted", JSON.stringify(r));

    const [row] = await db.select().from(mbosVisits).where(eq(mbosVisits.customerId, shop.id));
    assert.equal(row?.salesmanId, salesman.id);
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "mbos.work_after_reassignment"));
    assert.equal(audits.length, 1);
    const told = await db.select().from(notifications).where(eq(notifications.userId, other.id));
    assert.equal(told.length, 1, "the new holder hears about work on his account");
  });

  test("a tombstone written to his handset is a move away from him too", async () => {
    const shop = await rahulsShop();
    await db.insert(mbosDeletions).values({
      id: id("del"),
      entity: "customers",
      entityId: shop.id,
      userId: salesman.id,
      at: new Date(),
      reason: "reassigned",
    });
    const r = await visit(shop.id, { checkInAt: Date.now() - 30 * 60_000 });
    assert.equal(r.status, "accepted", JSON.stringify(r));
  });

  test("a shop that was never his is still refused", async () => {
    const shop = await rahulsShop();
    const r = await visit(shop.id);
    assert.equal(r.status, "rejected", JSON.stringify(r));
    assert.equal(r.code, "not_permitted");
    assert.equal((await db.select().from(mbosVisits).where(eq(mbosVisits.customerId, shop.id))).length, 0);
  });

  test("work dated well after the move, past the grace, is refused", async () => {
    const shop = await rahulsShop();
    /* Moved three days ago; the default grace is a day. */
    await movedAway(shop.id, new Date(Date.now() - 3 * 86_400_000));
    const r = await visit(shop.id);
    assert.equal(r.status, "rejected", JSON.stringify(r));
    assert.equal(r.code, "not_permitted");
  });

  test("a resend of an accepted visit does not ring the bell twice", async () => {
    const shop = await rahulsShop();
    await movedAway(shop.id, new Date());
    const visitId = id("visit");
    const send = () =>
      ingestSyncBatch(principal, [
        item({
          entityType: "visit",
          entityId: visitId,
          payload: {
            customerId: shop.id,
            checkInAt: Date.now() - 60 * 60_000,
            checkOutAt: Date.now() - 50 * 60_000,
            checkInLat: SHOP.lat,
            checkInLng: SHOP.lng,
            checkInAccuracyM: 12,
            outcome: "visited",
            notes: "Spoke to the owner about the thinner they use.",
          },
        }),
      ]);
    assert.equal((await send())[0]!.status, "accepted");
    await send();
    const told = await db.select().from(notifications).where(eq(notifications.userId, other.id));
    assert.equal(told.length, 1);
  });
});

/* A plan of Mahesh's on `planDate`, with one stop per shop given. */
async function planWith(planDate: string, shopIds: string[], dayState: "agreed" | "planned" | "proposed" = "planned") {
  const planId = id("plan");
  await db.insert(mbosJourneyPlans).values({ id: planId, userId: salesman.id, planDate, dayState, city: "Nagpur" });
  const stopIds: string[] = [];
  for (const [n, customerId] of shopIds.entries()) {
    const stopId = id("stop");
    stopIds.push(stopId);
    await db.insert(mbosJourneyStops).values({ id: stopId, planId, customerId, sequence: n + 1 });
  }
  return { planId, stopIds };
}

const stopRow = async (stopId: string) =>
  (await db.select().from(mbosJourneyStops).where(eq(mbosJourneyStops.id, stopId)))[0]!;

describe("7. A visit that names no stop still marks the stop it was", () => {
  test("matched by his plan, the IST day and the shop", async () => {
    const shop = await makeLead();
    const checkInAt = Date.now() - 10 * 60_000;
    const { stopIds } = await planWith(calendarDate(new Date(checkInAt)), [shop.id]);

    const r = await visit(shop.id, { checkInAt });
    assert.equal(r.status, "accepted", JSON.stringify(r));
    assert.equal((await stopRow(stopIds[0]!)).status, "visited");
    const [v] = await db.select().from(mbosVisits).where(eq(mbosVisits.customerId, shop.id));
    assert.equal(v?.journeyPlanStopId, stopIds[0]);
    assert.equal(v?.wasPlanned, true);
  });

  test("another day's stop for the same shop is left alone", async () => {
    const shop = await makeLead();
    const { stopIds } = await planWith(addDays(await today(), 3), [shop.id]);
    await visit(shop.id);
    assert.equal((await stopRow(stopIds[0]!)).status, "planned");
  });

  test("a skipped stop is not turned into a visited one", async () => {
    const shop = await makeLead();
    const checkInAt = Date.now() - 10 * 60_000;
    const { stopIds } = await planWith(calendarDate(new Date(checkInAt)), [shop.id]);
    await db
      .update(mbosJourneyStops)
      .set({ status: "skipped", skipReason: "Shut." })
      .where(eq(mbosJourneyStops.id, stopIds[0]!));
    await visit(shop.id, { checkInAt });
    assert.equal((await stopRow(stopIds[0]!)).status, "skipped");
  });
});

const skip = (stopId: string, reason: string | null) =>
  ingestSyncBatch(principal, [
    item({ entityType: "stop_skip", entityId: stopId, op: "update", payload: { id: stopId, reason } }),
  ]);

describe("8. A stop can be skipped from the phone, with a reason", () => {
  test("a planned stop moves to skipped with what he said, and his manager hears", async () => {
    const shop = await makeLead();
    const { stopIds } = await planWith(await today(), [shop.id]);
    const [r] = await skip(stopIds[0]!, "  Owner rang: shut for a wedding. ");
    assert.equal(r!.status, "accepted", JSON.stringify(r));
    const row = await stopRow(stopIds[0]!);
    assert.equal(row.status, "skipped");
    assert.equal(row.skipReason, "Owner rang: shut for a wedding.");
    const told = await db.select().from(notifications).where(eq(notifications.userId, manager.id));
    assert.equal(told.length, 1);
  });

  test("no reason is refused and the stop stays planned", async () => {
    const shop = await makeLead();
    const { stopIds } = await planWith(await today(), [shop.id]);
    const [r] = await skip(stopIds[0]!, "  ");
    assert.equal(r!.status, "rejected", JSON.stringify(r));
    assert.equal((await stopRow(stopIds[0]!)).status, "planned");
  });

  test("a visited stop stays visited, and the skip is accepted as nothing to do", async () => {
    const shop = await makeLead();
    const { stopIds } = await planWith(await today(), [shop.id]);
    await db.update(mbosJourneyStops).set({ status: "visited" }).where(eq(mbosJourneyStops.id, stopIds[0]!));
    const [r] = await skip(stopIds[0]!, "Shut.");
    assert.equal(r!.status, "accepted", JSON.stringify(r));
    assert.equal((await stopRow(stopIds[0]!)).status, "visited");
  });

  test("somebody else's stop is refused", async () => {
    const shop = await makeLead();
    const planId = id("plan");
    await db.insert(mbosJourneyPlans).values({ id: planId, userId: other.id, planDate: await today(), dayState: "planned" });
    const stopId = id("stop");
    await db.insert(mbosJourneyStops).values({ id: stopId, planId, customerId: shop.id, sequence: 1 });
    const [r] = await skip(stopId, "Shut.");
    assert.equal(r!.status, "rejected", JSON.stringify(r));
    assert.equal((await stopRow(stopId)).status, "planned");
  });
});

describe("9. A day he planned that the office had proposed is adopted, not refused", () => {
  const planDay = (planDate: string, city: string) =>
    ingestSyncBatch(principal, [
      item({
        entityType: "plan_day",
        entityId: id("plan"),
        op: "create",
        payload: { answer: "agreed", planDate, city },
      }),
    ]);

  test("the same city: accepted with the office's id, and the day is agreed", async () => {
    const planDate = addDays(await today(), 1);
    const { planId } = await planWith(planDate, [], "proposed");
    const [r] = await planDay(planDate, " nagpur ");
    assert.equal(r!.status, "accepted", JSON.stringify(r));
    assert.equal(r!.serverId, planId, "the handset adopts the office's day by this id");
    const [plan] = await db.select().from(mbosJourneyPlans).where(eq(mbosJourneyPlans.id, planId));
    assert.equal(plan?.dayState, "agreed");
    assert.equal((await db.select().from(mbosJourneyPlans).where(eq(mbosJourneyPlans.userId, salesman.id))).length, 1);
  });

  test("a different city: accepted with the office's id, and the proposal still waits", async () => {
    const planDate = addDays(await today(), 1);
    const { planId } = await planWith(planDate, [], "proposed");
    const [r] = await planDay(planDate, "Wardha");
    assert.equal(r!.status, "accepted", JSON.stringify(r));
    assert.equal(r!.serverId, planId);
    const [plan] = await db.select().from(mbosJourneyPlans).where(eq(mbosJourneyPlans.id, planId));
    assert.equal(plan?.dayState, "proposed");
    assert.equal(plan?.city, "Nagpur");

    /* …and his picks are refused in words that send him to the proposal,
       rather than retried for ever. */
    const shop = await makeLead();
    const [picks] = await ingestSyncBatch(principal, [
      item({ entityType: "plan_stops", entityId: planId, op: "update", payload: { id: planId, customerIds: [shop.id] } }),
    ]);
    assert.equal(picks!.status, "rejected", JSON.stringify(picks));
    assert.match(picks!.message ?? "", /Journey tab/);
  });
});

describe("10. \"I didn't leave\" reaches the manager and never costs the visit", () => {
  test("a dispute is audited once and the visit lands", async () => {
    const shop = await makeLead();
    const r = await visit(shop.id, {
      leftShopDispute: {
        reason: "Still at the counter. The godown roof bounces the signal.",
        seenAt: Date.now() - 5 * 60_000,
        metres: 620,
      },
    });
    assert.equal(r.status, "accepted", JSON.stringify(r));
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "mbos.visit.left_shop_disputed"));
    assert.equal(rows.length, 1);
  });

  test("a dispute in a shape the office cannot read is dropped, not refused", async () => {
    const shop = await makeLead();
    const r = await visit(shop.id, { leftShopDispute: { reason: 42 } });
    assert.equal(r.status, "accepted", JSON.stringify(r));
  });
});
