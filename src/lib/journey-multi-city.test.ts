/**
 * A JOURNEY DAY CAN NAME SEVERAL CITIES, AND A DAY WITH ONE IS EXACTLY WHAT IT WAS.
 *
 * `city` stays the PRIMARY city — the one every handset filters its shop list by —
 * and an additive `cities` carries the whole ordered list only where more than
 * one was named. What is pinned, against a real Postgres:
 *
 *   A SINGLE CITY IS STORED AS IT ALWAYS WAS. `cities` stays null, so every plan
 *   that exists, and every plan proposed with one city, reads and behaves exactly
 *   as before.
 *
 *   SEVERAL CITIES NEVER BECOME ONE STRING. `city` is the first, and holds no
 *   comma — a joined value would match no shop on a handset.
 *
 *   THE OFFICE'S RULES ARE UNCHANGED. A day he has agreed or picked shops for is
 *   left alone; his refusal and his counter-proposal still work; taking his
 *   counter-proposal makes the day his single city again.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, mbosJourneyPlans, mbosJourneyStops, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { answerRefusal, editJourneyDayStops, proposeJourneyDays, saveJourneyPeriod } from "@/lib/actions/sales";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { buildPull, type MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";
import { journeyPlansBetween } from "@/lib/services/sales-service";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type U = typeof users.$inferSelect;

let admin: U;
let salesman: U;

const DAY = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function makeUser(name: string, level: "associate" | "admin", apps: [string, "associate" | "admin"][]) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      passwordHash: "x",
      role: level,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  for (const [app, role] of apps) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: app as never, role });
  return row;
}

const planOn = async (date: string) => {
  const [r] = await db
    .select()
    .from(mbosJourneyPlans)
    .where(sql`${mbosJourneyPlans.userId} = ${salesman.id} and ${mbosJourneyPlans.planDate} = ${date}::date`);
  return r;
};

async function shop(city: string) {
  const [r] = await db
    .insert(customers)
    .values({ id: id("cus"), name: `Shop ${randomUUID().slice(0, 6)}`, phone: testPhone(), city, kind: "customer", salesAmId: salesman.id, ownerId: salesman.id })
    .returning();
  return r;
}

/* The actions end with `revalidatePath`, which throws outside a Next request once
   the work is done — the allowance the other journey and territory suites make. */
const landed = (r: { ok: boolean; error?: string }) => r.ok || /static generation store/.test(r.error ?? "");

before(() => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test|wtw_verify_|jmc_verify_/,
    "Run against `mahekone_test` (npm run test:db) or a disposable database — never the developer's.",
  );
});
after(async () => {
  setTestUser(null);
  await db.$client.end();
});
beforeEach(async () => {
  await db.execute(sql`
    truncate table notifications, audit_log, mbos_deletions, mbos_journey_stops, mbos_journey_plans, app_module_access, app_access,
      customers, users, app_settings restart identity cascade`);
  invalidateConfig();
  await seedConfig();
  admin = await makeUser("Pritesh Admin", "admin", [["sales", "admin"]]);
  salesman = await makeUser("Prashant Field", "associate", [["field", "associate"]]);
  setTestUser(admin);
});

describe("proposing a day", () => {
  test("ONE city is stored exactly as it always was: city set, cities null", async () => {
    const d = DAY(10);
    const r = await proposeJourneyDays({ salesmanId: salesman.id, days: [{ planDate: d, city: "Pune" }] });
    assert.ok(landed(r), JSON.stringify(r));
    const p = await planOn(d);
    assert.equal(p.city, "Pune");
    assert.equal(p.cities, null);
    assert.equal(p.dayState, "proposed");
  });

  test("SEVERAL cities: the first is the primary, all are stored in order, and `city` is never joined", async () => {
    const d = DAY(10);
    const r = await proposeJourneyDays({
      salesmanId: salesman.id,
      days: [{ planDate: d, city: "Pune", cities: ["Pune", "Thane", "Nagpur", "Nashik", "Wardha"] }],
    });
    assert.ok(landed(r), JSON.stringify(r));
    const p = await planOn(d);
    assert.equal(p.city, "Pune");
    assert.deepEqual(p.cities, ["Pune", "Thane", "Nagpur", "Nashik", "Wardha"], "no maximum, order kept");
    assert.ok(!/[,;/]/.test(p.city ?? ""), "the primary city holds one place and no separator");
  });

  test("the same city spelled twice is one city, and one city after dedupe leaves `cities` null", async () => {
    const d = DAY(10);
    await proposeJourneyDays({
      salesmanId: salesman.id,
      days: [{ planDate: d, city: "Pune", cities: ["pune", "  PUNE ", "Pune"] }],
    });
    const p = await planOn(d);
    assert.equal(p.city, "Pune");
    assert.equal(p.cities, null);
  });

  test("proposing a single city over a multi-city day clears `cities`", async () => {
    const d = DAY(10);
    await proposeJourneyDays({ salesmanId: salesman.id, days: [{ planDate: d, city: "Pune", cities: ["Pune", "Thane"] }] });
    assert.equal((await planOn(d)).cities?.length, 2);
    await proposeJourneyDays({ salesmanId: salesman.id, days: [{ planDate: d, city: "Nagpur" }] });
    const p = await planOn(d);
    assert.equal(p.city, "Nagpur");
    assert.equal(p.cities, null);
  });

  test("a day he has AGREED is still left alone, however many cities are proposed", async () => {
    const d = DAY(10);
    await proposeJourneyDays({ salesmanId: salesman.id, days: [{ planDate: d, city: "Pune" }] });
    await db.update(mbosJourneyPlans).set({ dayState: "agreed" }).where(eq(mbosJourneyPlans.id, (await planOn(d)).id));
    const r = await proposeJourneyDays({
      salesmanId: salesman.id,
      days: [{ planDate: d, city: "Thane", cities: ["Thane", "Nagpur"] }],
    });
    assert.ok(landed(r), JSON.stringify(r));
    const p = await planOn(d);
    assert.equal(p.city, "Pune");
    assert.equal(p.cities, null);
    assert.equal(p.dayState, "agreed");
  });

  test("the notification to the salesman names every city of a multi-city day", async () => {
    const d = DAY(10);
    await proposeJourneyDays({ salesmanId: salesman.id, days: [{ planDate: d, city: "Pune", cities: ["Pune", "Thane", "Nagpur"] }] });
    const [n] = await db.execute<{ body: string }>(sql`select body from notifications where user_id = ${salesman.id}`);
    assert.match(n.body, /Pune, Thane and Nagpur/);
  });

  test("a day with ONE city sends the notification it always did — nothing about cities added", async () => {
    await proposeJourneyDays({ salesmanId: salesman.id, days: [{ planDate: DAY(10), city: "Pune" }] });
    const [n] = await db.execute<{ body: string }>(sql`select body from notifications where user_id = ${salesman.id}`);
    assert.doesNotMatch(n.body, /more than one city/);
  });
});

describe("reading a day", () => {
  test("a plan that predates `cities` reads as its one city", async () => {
    const d = DAY(10);
    await db.insert(mbosJourneyPlans).values({ id: id("mbos_plan"), userId: salesman.id, planDate: d, city: "Pune", dayState: "agreed", status: "draft" });
    const [p] = await journeyPlansBetween(d, d, salesman.id);
    assert.equal(p.city, "Pune");
    assert.deepEqual(p.cities, ["Pune"]);
  });

  test("a multi-city day reads as every city, primary first", async () => {
    const d = DAY(10);
    await proposeJourneyDays({ salesmanId: salesman.id, days: [{ planDate: d, city: "Pune", cities: ["Pune", "Thane"] }] });
    const [p] = await journeyPlansBetween(d, d, salesman.id);
    assert.equal(p.city, "Pune");
    assert.deepEqual(p.cities, ["Pune", "Thane"]);
  });

  test("a day with no city reads as none", async () => {
    const d = DAY(10);
    await db.insert(mbosJourneyPlans).values({ id: id("mbos_plan"), userId: salesman.id, planDate: d, dayState: "planned", status: "draft" });
    const [p] = await journeyPlansBetween(d, d, salesman.id);
    assert.equal(p.city, null);
    assert.deepEqual(p.cities, []);
  });
});

describe("his refusal and the office's answer", () => {
  async function refusedDay(counter: string | null) {
    const d = DAY(10);
    await proposeJourneyDays({ salesmanId: salesman.id, days: [{ planDate: d, city: "Pune", cities: ["Pune", "Thane"] }] });
    const p = await planOn(d);
    await db
      .update(mbosJourneyPlans)
      .set({ dayState: "refused", refusalReason: "Festival in Pune", counterCity: counter, respondedAt: new Date() })
      .where(eq(mbosJourneyPlans.id, p.id));
    return { d, planId: p.id };
  }

  test("taking his counter-proposal makes the day his single city again, and agrees it", async () => {
    const { d, planId } = await refusedDay("Nagpur");
    const r = await answerRefusal({ planId, take: "counter" });
    assert.ok(landed(r), JSON.stringify(r));
    const p = await planOn(d);
    assert.equal(p.city, "Nagpur");
    assert.equal(p.cities, null);
    assert.equal(p.dayState, "agreed");
  });

  test("putting different cities back to him stores them all and asks him again", async () => {
    const { d, planId } = await refusedDay("Nagpur");
    const r = await answerRefusal({ planId, take: "other", city: "Nashik", cities: ["Nashik", "Wardha", "Amravati"] });
    assert.ok(landed(r), JSON.stringify(r));
    const p = await planOn(d);
    assert.equal(p.city, "Nashik");
    assert.deepEqual(p.cities, ["Nashik", "Wardha", "Amravati"]);
    assert.equal(p.dayState, "proposed");
    assert.equal(p.counterCity, null);
  });

  test("putting a single city back to him still works", async () => {
    const { d, planId } = await refusedDay(null);
    const r = await answerRefusal({ planId, take: "other", city: "Nashik" });
    assert.ok(landed(r), JSON.stringify(r));
    const p = await planOn(d);
    assert.equal(p.city, "Nashik");
    assert.equal(p.cities, null);
  });

  test("taking a counter-proposal he never made is still refused", async () => {
    const { planId } = await refusedDay(null);
    const r = await answerRefusal({ planId, take: "counter" });
    assert.ok(!r.ok && r.code === "validation", JSON.stringify(r));
  });
});

describe("arranging the shops from the office", () => {
  test("a multi-city day saves every city beside its shops", async () => {
    const d = DAY(12);
    const a = await shop("Pune");
    const b = await shop("Thane");
    const r = await saveJourneyPeriod({
      salesmanId: salesman.id,
      days: [{ planDate: d, city: "Pune", cities: ["Pune", "Thane"], customerIds: [a.id, b.id] }],
    });
    assert.ok(landed(r), JSON.stringify(r));
    const p = await planOn(d);
    assert.equal(p.city, "Pune");
    assert.deepEqual(p.cities, ["Pune", "Thane"]);
    const stops = await db.select().from(mbosJourneyStops).where(eq(mbosJourneyStops.planId, p.id));
    assert.equal(stops.length, 2);
  });

  test("a single-city day saves as it always did, and a day saved with no city keeps the one it had", async () => {
    const d = DAY(12);
    const a = await shop("Pune");
    await saveJourneyPeriod({ salesmanId: salesman.id, days: [{ planDate: d, city: "Pune", customerIds: [a.id] }] });
    let p = await planOn(d);
    assert.equal(p.city, "Pune");
    assert.equal(p.cities, null);

    await saveJourneyPeriod({ salesmanId: salesman.id, days: [{ planDate: d, customerIds: [a.id] }] });
    p = await planOn(d);
    assert.equal(p.city, "Pune", "no city given leaves the day's city alone");
  });
});

/* ------------------------------------------- the office editing a day's shops */

const stopsOn = async (date: string) => {
  const p = await planOn(date);
  return db
    .select()
    .from(mbosJourneyStops)
    .where(eq(mbosJourneyStops.planId, p.id))
    .orderBy(mbosJourneyStops.sequence);
};

const edit = async (planDate: string, add: string[], remove: string[] = [], city = "Mumbai") => {
  const r = await editJourneyDayStops({ salesmanId: salesman.id, planDate, city, cities: [city], add, remove });
  assert.ok(landed(r), r.ok ? "" : r.error);
};

const shops = async (n: number) => {
  const made = [];
  for (let i = 0; i < n; i++) made.push(await shop("Mumbai"));
  return made;
};

const handset = (): MbosPrincipal => ({
  user: salesman,
  deviceId: "probe-device",
  role: "associate",
  scope: { kind: "own", userIds: [salesman.id] },
});

const sent = (entityType: string, entityId: string, payload: Record<string, unknown>): SyncItem =>
  ({
    queueId: id("q"),
    entityType,
    entityId,
    op: "update",
    idempotencyKey: `${entityId}:${randomUUID()}`,
    clientCreatedAt: Date.now(),
    payload,
  }) as SyncItem;

describe("editing a day's shops from the office", () => {
  test("saving a second time ADDS to the day, and the earlier stops are the same rows", async () => {
    const d = DAY(3);
    const [a, b, c] = await shops(3);
    await edit(d, [a.id, b.id]);
    const first = await stopsOn(d);

    await edit(d, [c.id]);
    const second = await stopsOn(d);

    assert.deepEqual(second.map((s) => s.customerId), [a.id, b.id, c.id]);
    assert.deepEqual(second.slice(0, 2), first, "an untouched stop was rewritten");
  });

  test("only the shop named for removal leaves, and adding one already there does nothing", async () => {
    const d = DAY(3);
    const [a, b, c] = await shops(3);
    await edit(d, [a.id, b.id, c.id]);
    const [first, , third] = await stopsOn(d);
    await edit(d, [a.id], [b.id]);
    const left = await stopsOn(d);
    assert.deepEqual(left.map((s) => s.customerId), [a.id, c.id]);
    assert.deepEqual(left.map((s) => s.id), [first.id, third.id], "a kept stop was replaced");
    assert.deepEqual(left.map((s) => s.sequence), [1, 2]);
  });

  test("a visited shop is never removed", async () => {
    const d = DAY(3);
    const [a, b] = await shops(2);
    await edit(d, [a.id, b.id]);
    const [visited] = await stopsOn(d);
    await db.update(mbosJourneyStops).set({ status: "visited" }).where(eq(mbosJourneyStops.id, visited.id));
    await edit(d, [], [a.id, b.id]);
    assert.deepEqual((await stopsOn(d)).map((s) => s.customerId), [a.id]);
  });

  test("a proposed day becomes planned, and emptying it hands it back as proposed", async () => {
    const d = DAY(4);
    const a = await shop("Mumbai");
    await proposeJourneyDays({ salesmanId: salesman.id, days: [{ planDate: d, city: "Mumbai" }] });
    await edit(d, [a.id]);
    assert.equal((await planOn(d)).dayState, "planned");

    await edit(d, [], [a.id]);
    assert.equal((await planOn(d)).dayState, "proposed");
    assert.equal((await stopsOn(d)).length, 0);
  });

  test("a refused day stays refused, and a past day keeps its state", async () => {
    const refused = DAY(4);
    const past = DAY(-4);
    const a = await shop("Mumbai");
    for (const d of [refused, past]) {
      await proposeJourneyDays({ salesmanId: salesman.id, days: [{ planDate: d, city: "Mumbai" }] });
    }
    await db
      .update(mbosJourneyPlans)
      .set({ dayState: "refused", refusalReason: "Market shut" })
      .where(eq(mbosJourneyPlans.id, (await planOn(refused)).id));

    await edit(refused, [a.id]);
    await edit(past, [a.id]);
    assert.equal((await planOn(refused)).dayState, "refused");
    assert.equal((await planOn(past)).dayState, "proposed");
  });

  test("a planned day that has gone by is not changed", async () => {
    const d = DAY(-4);
    const [a, b] = await shops(2);
    await edit(d, [a.id]);
    const r = await editJourneyDayStops({ salesmanId: salesman.id, planDate: d, add: [b.id], remove: [] });
    assert.equal(r.ok, false);
    assert.equal((await stopsOn(d)).length, 1);
  });

  test("a day the SALESMAN picked is not changed from the office, and his own pick still works", async () => {
    const d = DAY(5);
    const [a, b, c] = await shops(3);
    await proposeJourneyDays({ salesmanId: salesman.id, days: [{ planDate: d, city: "Mumbai" }] });
    const planId = (await planOn(d)).id;
    await db.update(mbosJourneyPlans).set({ dayState: "agreed" }).where(eq(mbosJourneyPlans.id, planId));

    const [picked] = await ingestSyncBatch(handset(), [sent("plan_stops", planId, { customerIds: [a.id, b.id] })]);
    assert.equal(picked.status, "accepted", JSON.stringify(picked));

    const [plan] = await journeyPlansBetween(d, d, salesman.id);
    assert.equal(plan.officeArranged, false);
    const r = await editJourneyDayStops({ salesmanId: salesman.id, planDate: d, add: [c.id], remove: [a.id] });
    assert.equal(r.ok, false);
    assert.deepEqual((await stopsOn(d)).map((s) => s.customerId), [a.id, b.id]);

    const [again] = await ingestSyncBatch(handset(), [sent("plan_stops", planId, { customerIds: [b.id, c.id] })]);
    assert.equal(again.status, "accepted", JSON.stringify(again));
    assert.deepEqual((await stopsOn(d)).map((s) => s.customerId), [b.id, c.id]);
  });

  test("the phone is sent exactly the final list, and told which stops went", async () => {
    const d = DAY(2);
    const [a, b, c] = await shops(3);
    await proposeJourneyDays({ salesmanId: salesman.id, days: [{ planDate: d, city: "Mumbai" }] });
    await edit(d, [a.id, b.id]);
    const [, second] = await stopsOn(d);
    const before = await buildPull(handset(), null);
    const held = (before.journeyStops as Array<{ id: string }>).map((s) => s.id);

    await edit(d, [c.id], [b.id]);
    const delta = await buildPull(handset(), before.cursor);

    const gone = delta.deletions.find((g) => g.entity === "journey_stops")?.ids ?? [];
    assert.ok(gone.includes(second.id), "the removed stop was never tombstoned");

    const arrived = delta.journeyStops as Array<{ id: string }>;
    const onPhone = new Set([...held, ...arrived.map((s) => s.id)]);
    for (const g of gone) onPhone.delete(g);
    const server = await stopsOn(d);
    assert.deepEqual([...onPhone].sort(), server.map((s) => s.id).sort());
    assert.deepEqual(server.map((s) => s.customerId), [a.id, c.id]);

    const day = (delta.planDays as Array<{ planDate: string; dayState: string; picked: number }>).find(
      (p) => p.planDate === d,
    );
    assert.equal(day?.dayState, "planned");
    assert.equal(day?.picked, 2);
  });
});
