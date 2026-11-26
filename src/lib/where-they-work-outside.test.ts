/**
 * NARROWING A TERRITORY SAYS WHAT IT LEAVES OUTSIDE, AND SAVE WILL NOT GO
 * AHEAD WITHOUT A YES THAT STILL MATCHES.
 *
 * In a state with something narrower than the whole state picked under it, a
 * shop that no district holds is reached by a whole-state pick and — for a
 * district or a town — by nothing finer; a typed city reaches it only if the
 * city text matches. What is pinned, against a real Postgres:
 *
 *   THE COUNT IS PER STATE and is for exactly the areas sent. A deleted shop is
 *   not counted, and `mine` is how many of them are on his book now.
 *
 *   A DISTRICT TEST ON A SHOP WITH NO DISTRICT IS NULL, not false. `NOT NULL`
 *   is NULL, so a count written `not (clause)` returns nothing for exactly the
 *   shops it is meant to count — which is what these tests would catch.
 *
 *   THE SERVER DECIDES. A missing acknowledgement is refused, a stale count in
 *   ANY state is refused (a total that still adds up is not enough), an exact
 *   one passes, and a save that changes nothing never needs one.
 *
 *   A TYPED CITY CAN REACH AN UNPLACED SHOP, so what it reaches is not left
 *   outside. A city with no state is not guessed into one.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, mbosUserTerritories, places, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { previewAreaHandover, setSalesmanTerritories } from "@/lib/actions/sales";
import { placeKey } from "@/lib/place-parse";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type U = typeof users.$inferSelect;

let admin: U;
let salesman: U;
let holder: U;
let thane: string;
let ahmedabad: string;

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

async function place(kind: string, name: string, parentId: string | null) {
  const [r] = await db.insert(places).values({ id: id("pl"), kind, name, key: placeKey(name), parentId }).returning();
  return r.id;
}

async function shop(over: Partial<typeof customers.$inferInsert>) {
  const [r] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Shop ${randomUUID().slice(0, 6)}`,
      phone: testPhone(),
      city: "Pune",
      territoryRegion: "Maharashtra",
      kind: "customer",
      salesAmId: holder.id,
      ownerId: holder.id,
      ...over,
    })
    .returning();
  return r;
}

const areasOf = async (uid: string) =>
  (await db.select().from(mbosUserTerritories).where(sql`${mbosUserTerritories.userId} = ${uid}`))
    .map((t) => `${t.kind}:${t.region}`)
    .sort();

/* The action ends with `revalidatePath`, which throws outside a Next request
   once the work is done — the allowance area-handover.test.ts makes too. */
const saved = (r: { ok: boolean; error?: string }) => r.ok || /static generation store/.test(r.error ?? "");

const THANE = [{ kind: "district", value: "Thane", parent: "Maharashtra" }];
const THANE_AND_AHMEDABAD = [...THANE, { kind: "district", value: "Ahmedabad", parent: "Gujarat" }];
const NAGPUR_CITY = [{ kind: "city", value: "Nagpur", parent: "Maharashtra" }];

before(() => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test|wtw_verify_/,
    "Run against `mahekone_test` (npm run test:db) or a disposable wtw_verify_ database — never the developer's.",
  );
});
after(async () => {
  setTestUser(null);
  await db.$client.end();
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table customer_am_changes, notifications, timeline_events, audit_log, app_module_access, app_access,
      mbos_user_territories, customers, places, users, app_settings restart identity cascade`);
  invalidateConfig();
  await seedConfig();
  admin = await makeUser("Pritesh Admin", "admin", [["sales", "admin"]]);
  salesman = await makeUser("Prashant Field", "associate", [["field", "associate"]]);
  holder = await makeUser("Seema Holder", "associate", [["crm", "associate"]]);

  const mh = await place("state", "Maharashtra", null);
  thane = await place("district", "Thane", mh);
  const gj = await place("state", "Gujarat", null);
  ahmedabad = await place("district", "Ahmedabad", gj);

  /* MAHARASHTRA — one shop the tree placed in Thane, two it placed in no
     district (one of them on the salesman's own book), one deleted. */
  await shop({ city: "Thane", resolvedDistrictId: thane });
  await shop({ city: "Nagpur", salesAmId: salesman.id });
  await shop({ city: "Kalyan" });
  await shop({ city: "Nagpur", deletedAt: new Date() });
  /* A deactivated shop in no district is not an ACTIVE shop: it is left out of the
     count, as it is left out of the hand-over, so both figures in the dialog mean
     the same kind of shop. */
  await shop({ city: "Kalyan", status: "deactivated" });

  /* GUJARAT — one placed in Ahmedabad, two placed in no district. */
  await shop({ city: "Ahmedabad", territoryRegion: "Gujarat", resolvedDistrictId: ahmedabad });
  await shop({ city: "Surat", territoryRegion: "Gujarat" });
  await shop({ city: "Surat", territoryRegion: "Gujarat" });
});

describe("the shops a narrowed territory leaves outside", () => {
  test("a district pick counts the shops in no district — a NULL district test must not hide them", async () => {
    setTestUser(admin);
    const r = await previewAreaHandover({ salesmanId: salesman.id, territories: THANE });
    assert.ok(r.ok, JSON.stringify(r));
    /* 2 ACTIVE shops in no district: Nagpur and Kalyan. The deleted one and the
       deactivated one are not counted, and the shop in Thane is reached. If the
       count were written
       `not (district clause)` this would be 0. */
    assert.deepEqual(r.data.outside, [{ state: "Maharashtra", shops: 2, mine: 1 }]);
    assert.equal(r.data.changed, true);
  });

  test("the count is per state", async () => {
    setTestUser(admin);
    const r = await previewAreaHandover({ salesmanId: salesman.id, territories: THANE_AND_AHMEDABAD });
    assert.ok(r.ok, JSON.stringify(r));
    const by = Object.fromEntries(r.data.outside.map((o) => [o.state, o.shops]));
    assert.deepEqual(by, { Maharashtra: 2, Gujarat: 2 });
  });

  test("a whole-state pick narrows nothing, so nothing is left outside", async () => {
    setTestUser(admin);
    const r = await previewAreaHandover({
      salesmanId: salesman.id,
      territories: [{ kind: "state", value: "Maharashtra", parent: "" }],
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.data.outside, []);
  });

  test("a typed city reaches the unplaced shop whose city text matches, so only the rest is left outside", async () => {
    setTestUser(admin);
    const r = await previewAreaHandover({ salesmanId: salesman.id, territories: NAGPUR_CITY });
    assert.ok(r.ok, JSON.stringify(r));
    /* Nagpur (on his book) is reached; Kalyan is not. `mine` counts the
       unreached ones only, so it is 0. */
    assert.deepEqual(r.data.outside, [{ state: "Maharashtra", shops: 1, mine: 0 }]);
  });

  test("a district AND a typed city together: the city reaches what the district cannot", async () => {
    setTestUser(admin);
    const r = await previewAreaHandover({ salesmanId: salesman.id, territories: [...THANE, ...NAGPUR_CITY] });
    assert.ok(r.ok, JSON.stringify(r));
    /* For the Nagpur shop: NULL (district) OR true (city) is true. For Kalyan:
       NULL OR false is NULL — which must still count as left outside. */
    assert.deepEqual(r.data.outside, [{ state: "Maharashtra", shops: 1, mine: 0 }]);
  });

  test("a typed city that never named its state has no state to count under and is not guessed into one", async () => {
    setTestUser(admin);
    const r = await previewAreaHandover({
      salesmanId: salesman.id,
      territories: [{ kind: "state", value: "Maharashtra", parent: "" }, { kind: "city", value: "Nagpur", parent: "" }],
    });
    /* The dialog never sends a parentless city next to a state; if something
       does, the server's own rule answers — it does not invent a count. */
    if (r.ok) assert.deepEqual(r.data.outside, []);
  });
});

describe("saving a narrowed territory", () => {
  test("a missing acknowledgement is refused and nothing is saved", async () => {
    setTestUser(admin);
    const r = await setSalesmanTerritories({ salesmanId: salesman.id, territories: THANE });
    assert.ok(!r.ok && r.code === "conflict", JSON.stringify(r));
    assert.match(r.error, /Confirm/);
    assert.deepEqual(await areasOf(salesman.id), []);
  });

  test("a stale count in ANY state is refused, naming the state", async () => {
    setTestUser(admin);
    const r = await setSalesmanTerritories({
      salesmanId: salesman.id,
      territories: THANE_AND_AHMEDABAD,
      acknowledgedOutside: [{ state: "Maharashtra", shops: 2 }, { state: "Gujarat", shops: 1 }],
    });
    assert.ok(!r.ok && r.code === "conflict", JSON.stringify(r));
    assert.match(r.error, /Gujarat/);
    assert.match(r.error, /2 now, 1 confirmed/);
    assert.deepEqual(await areasOf(salesman.id), []);
  });

  test("a total that adds up is not enough when the states differ", async () => {
    setTestUser(admin);
    const r = await setSalesmanTerritories({
      salesmanId: salesman.id,
      territories: THANE_AND_AHMEDABAD,
      acknowledgedOutside: [{ state: "Maharashtra", shops: 1 }, { state: "Gujarat", shops: 3 }],
    });
    assert.ok(!r.ok && r.code === "conflict", JSON.stringify(r));
    assert.deepEqual(await areasOf(salesman.id), []);
  });

  test("a state left out of the acknowledgement counts as zero confirmed", async () => {
    setTestUser(admin);
    const r = await setSalesmanTerritories({
      salesmanId: salesman.id,
      territories: THANE_AND_AHMEDABAD,
      acknowledgedOutside: [{ state: "Maharashtra", shops: 2 }],
    });
    assert.ok(!r.ok && r.code === "conflict", JSON.stringify(r));
    assert.match(r.error, /Gujarat/);
  });

  test("the exact acknowledgement saves, and then an unchanged save needs none", async () => {
    setTestUser(admin);
    const first = await setSalesmanTerritories({
      salesmanId: salesman.id,
      territories: THANE,
      acknowledgedOutside: [{ state: "Maharashtra", shops: 2 }],
    });
    assert.ok(saved(first), JSON.stringify(first));
    assert.deepEqual(await areasOf(salesman.id), ["district:Thane"]);

    const preview = await previewAreaHandover({ salesmanId: salesman.id, territories: THANE });
    assert.ok(preview.ok, JSON.stringify(preview));
    assert.equal(preview.data.changed, false, "the same areas change nothing");

    const again = await setSalesmanTerritories({ salesmanId: salesman.id, territories: THANE });
    assert.ok(again.ok, JSON.stringify(again));
    assert.equal(again.message, "Nothing changed.");
  });

  test("a whole-state save needs no acknowledgement", async () => {
    setTestUser(admin);
    const r = await setSalesmanTerritories({
      salesmanId: salesman.id,
      territories: [{ kind: "state", value: "Maharashtra", parent: "" }],
    });
    assert.ok(saved(r), JSON.stringify(r));
    assert.deepEqual(await areasOf(salesman.id), ["state:Maharashtra"]);
  });

  test("a town with no shop is refused until that town is confirmed, and nothing is saved before", async () => {
    setTestUser(admin);
    const territories = [{ kind: "town", value: "Murbad", parent: "Thane, Maharashtra" }];
    /* The shops left outside are confirmed, so what is left to refuse is the town. */
    const preview = await previewAreaHandover({ salesmanId: salesman.id, territories });
    assert.ok(preview.ok, JSON.stringify(preview));
    const acknowledgedOutside = preview.data.outside.map((o) => ({ state: o.state, shops: o.shops }));

    const refused = await setSalesmanTerritories({ salesmanId: salesman.id, territories, acknowledgedOutside });
    assert.ok(!refused.ok && refused.code === "conflict", JSON.stringify(refused));
    assert.match(refused.error, /Murbad · Thane has no shops/);
    assert.deepEqual(await areasOf(salesman.id), []);

    const ok = await setSalesmanTerritories({
      salesmanId: salesman.id,
      territories,
      acknowledgedOutside,
      acknowledgedZeroTowns: ["Murbad · Thane"],
    });
    assert.ok(saved(ok), JSON.stringify(ok));
    assert.deepEqual(await areasOf(salesman.id), ["town:Murbad"]);
  });

  test("a typed city is acknowledged for what it leaves out, and only that", async () => {
    setTestUser(admin);
    const refused = await setSalesmanTerritories({ salesmanId: salesman.id, territories: NAGPUR_CITY });
    assert.ok(!refused.ok && refused.code === "conflict", JSON.stringify(refused));

    const ok = await setSalesmanTerritories({
      salesmanId: salesman.id,
      territories: NAGPUR_CITY,
      acknowledgedOutside: [{ state: "Maharashtra", shops: 1 }],
    });
    assert.ok(saved(ok), JSON.stringify(ok));
    assert.deepEqual(await areasOf(salesman.id), ["city:Nagpur"]);
  });
});
