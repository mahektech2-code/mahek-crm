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
import { answerRefusal, proposeJourneyDays, saveJourneyPeriod } from "@/lib/actions/sales";
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
    truncate table notifications, audit_log, mbos_journey_stops, mbos_journey_plans, app_module_access, app_access,
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
