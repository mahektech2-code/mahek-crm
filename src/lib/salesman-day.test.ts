/**
 * One salesman's whole day — the page Today and the Live map open in a new tab.
 *
 * The reads behind it are new SQL, and the rule this codebase has learned the
 * hard way is that a query nothing executes is a query that fails first on a
 * phone in Nagpur. So this runs every one of them against a real day: a punch,
 * a planned stop, a visit, an order, a payment, a sample, a trail — and checks
 * each comes back, in his day and nobody else's.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  customers,
  mbosActivityLocations,
  mbosAttendanceDays,
  mbosJourneyPlans,
  mbosJourneyStops,
  mbosPositions,
  mbosSamples,
  mbosVisits,
  orders,
  paymentReceipts,
  users,
} from "@/db/schema";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { setTestUser } from "@/lib/auth";
import { salesmanDay } from "@/lib/services/salesman-day-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const DAY = "2026-10-08";
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+05:30`);

let salesman: typeof users.$inferSelect;
let other: typeof users.$inferSelect;
let shop: typeof customers.$inferSelect;
let lead: typeof customers.$inferSelect;

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      mbos_activity_locations, mbos_samples, mbos_visits, mbos_positions,
      mbos_attendance_days, mbos_journey_stops, mbos_journey_plans,
      payment_receipts, orders, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  /* No signed-in user: the scope answers "nothing narrowed", which is what a
     platform administrator sees. Narrowing has its own tests. */
  setTestUser(null);

  [salesman] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Mahesh Patil", email: "mahesh@test.local", phone: "9820011007", passwordHash: "x", role: "associate", initials: "MP" })
    .returning();
  [other] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Rahul", email: "rahul@test.local", phone: "9820011008", passwordHash: "x", role: "associate", initials: "RR" })
    .returning();
  await db.insert(appAccess).values([
    { id: id("acc"), userId: salesman.id, app: "field" },
    { id: id("acc"), userId: other.id, app: "field" },
  ]);

  [shop] = await db
    .insert(customers)
    .values({ id: id("cus"), name: "Sai Paint Depot", phone: "9822200011", city: "Nagpur", kind: "customer", ownerId: salesman.id, salesAmId: salesman.id })
    .returning();
  [lead] = await db
    .insert(customers)
    .values({ id: id("cus"), name: "New Colour House", phone: "9822200012", city: "Nagpur", kind: "lead", ownerId: salesman.id })
    .returning();
});

after(async () => {
  await db.$client.end();
});

describe("A salesman's day", () => {
  test("reads the punch, the plan, the visit, the order, the payment, the acts and the trail", async () => {
    await db.insert(mbosAttendanceDays).values({
      id: id("att"),
      userId: salesman.id,
      day: DAY,
      checkInAt: at("09:00"),
      checkOutAt: at("18:00"),
      sessions: [{ inAt: at("09:00").getTime(), outAt: at("18:00").getTime(), inSelfieId: null, outSelfieId: null }],
    } as typeof mbosAttendanceDays.$inferInsert);

    const planId = id("plan");
    await db.insert(mbosJourneyPlans).values({ id: planId, userId: salesman.id, planDate: DAY, city: "Nagpur" } as typeof mbosJourneyPlans.$inferInsert);
    await db.insert(mbosJourneyStops).values([
      { id: id("stop"), planId, customerId: shop.id, sequence: 1, status: "visited", actualVisitAt: at("10:00") },
      { id: id("stop"), planId, customerId: lead.id, sequence: 2 },
    ] as (typeof mbosJourneyStops.$inferInsert)[]);

    const visitId = id("vis");
    await db.insert(mbosVisits).values({
      id: visitId,
      salesmanId: salesman.id,
      customerId: shop.id,
      checkInAt: at("10:00"),
      checkOutAt: at("10:25"),
      durationSeconds: 25 * 60,
      outcome: "order",
      verified: true,
      checkInLat: 21.16,
      checkInLng: 79.08,
      notes: "Wants 20 L of Nano next week",
    } as typeof mbosVisits.$inferInsert);

    const orderId = id("ord");
    await db.insert(orders).values({
      id: orderId,
      customerId: shop.id,
      createdById: salesman.id,
      source: "mbos",
      orderedAt: at("10:15"),
      totalAmount: 48_000_00,
      status: "pending_approval",
      lineItems: [{ product: "Nano Thinner", quantity: 4, amount: 48_000_00 }],
      visitId,
    } as typeof orders.$inferInsert);

    await db.insert(paymentReceipts).values({
      id: id("rec"),
      customerId: shop.id,
      amount: 12_000_00,
      receivedAt: DAY,
      mode: "UPI",
      status: "reported",
      source: "mbos",
      reportedById: salesman.id,
      idempotencyKey: id("key"),
      createdAt: at("10:20"),
    } as typeof paymentReceipts.$inferInsert);

    const sampleId = id("smp");
    await db.insert(mbosSamples).values({
      id: sampleId,
      customerId: lead.id,
      salesmanId: salesman.id,
      quantityCans: 2,
    } as typeof mbosSamples.$inferInsert);
    await db.insert(mbosActivityLocations).values([
      { id: id("loc"), entityType: "sample", entityId: sampleId, userId: salesman.id, lat: 21.17, lng: 79.09, capturedAt: at("11:30") },
      { id: id("loc"), entityType: "lead", entityId: lead.id, userId: salesman.id, lat: 21.17, lng: 79.09, capturedAt: at("11:20") },
      /* Orders and visits are read off their own tables; their activity rows are not listed twice. */
      { id: id("loc"), entityType: "order", entityId: orderId, userId: salesman.id, lat: 21.16, lng: 79.08, capturedAt: at("10:15") },
      /* Somebody else's act, the same day — never on his page. */
      { id: id("loc"), entityType: "task", entityId: id("tsk"), userId: other.id, lat: 21.1, lng: 79.0, capturedAt: at("11:00") },
    ] as (typeof mbosActivityLocations.$inferInsert)[]);

    await db.insert(mbosPositions).values(
      [0, 1, 2, 3].map((i) => ({
        id: `${at("09:0" + i).toISOString()}|21.1${i}|79.08`,
        userId: salesman.id,
        lat: 21.1 + i / 100,
        lng: 79.08,
        at: at(`09:0${i}`),
        accuracyM: 10,
      })) as (typeof mbosPositions.$inferInsert)[],
    );

    const day = await salesmanDay(salesman.id, DAY);
    assert.ok(day, "his day is found");
    assert.equal(day.person.salesmanName, "Mahesh Patil");

    assert.equal(day.attendance?.sessions.length, 1);
    assert.equal(new Date(day.attendance!.sessions[0].inAt!).getTime(), at("09:00").getTime());

    assert.equal(day.plan?.city, "Nagpur");
    assert.equal(day.plan?.stops.length, 2);
    assert.equal(day.plan?.stops[0].customerName, "Sai Paint Depot");

    assert.equal(day.visits.length, 1);
    assert.equal(day.visits[0].notes, "Wants 20 L of Nano next week");

    assert.equal(day.orders.length, 1);
    assert.equal(day.orders[0].totalPaise, 48_000_00);
    assert.equal(day.orders[0].lines, 1);
    assert.equal(day.orders[0].customerName, "Sai Paint Depot");

    assert.equal(day.payments.length, 1);
    assert.equal(day.payments[0].amountPaise, 12_000_00);

    const kinds = day.acts.map((a) => a.entityType).sort();
    assert.deepEqual(kinds, ["lead", "sample"], "no order, visit or anybody else's act");
    const sample = day.acts.find((a) => a.entityType === "sample")!;
    assert.equal(sample.customerName, "New Colour House");
    assert.match(sample.detail ?? "", /2 cans/);

    /* The trail, with the visit folded in where it stood. */
    assert.ok(day.trail.length >= 4);
  });

  test("a salesman with nothing recorded still has a day; somebody unknown has none", async () => {
    const empty = await salesmanDay(other.id, DAY);
    assert.ok(empty);
    assert.equal(empty.attendance, null);
    assert.equal(empty.plan, null);
    assert.deepEqual([empty.visits.length, empty.orders.length, empty.payments.length, empty.acts.length], [0, 0, 0, 0]);

    assert.equal(await salesmanDay("usr_nobody", DAY), null);
  });
});
