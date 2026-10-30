/**
 * GIVING A SALESMAN AN AREA CAN HAND HIM ITS SHOPS.
 *
 * An area narrows a book and stays a narrowing; the hand-over is the second,
 * named act the "Where … works" dialog offers beside it. What is pinned:
 *
 *   WHAT MOVES IS WHAT HIS PHONE WOULD SHOW. The shops in the areas, in
 *   somebody else's book, by the territory clause his handset reads — and not
 *   a shop outside them, and not one somebody deactivated.
 *
 *   ONLY THE NUMBER SHOWN. A count that no longer matches is refused, and
 *   neither the areas nor the shops move.
 *
 *   IT IS `customer.reassign`. A sales manager can set the areas and is told
 *   the shops stay where they are; asking to move them is refused.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customerAmChanges, customers, mbosUserTerritories, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { previewAreaHandover, setSalesmanTerritories } from "@/lib/actions/sales";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type Level = "associate" | "manager" | "admin";
type U = typeof users.$inferSelect;

let admin: U; // holds customer.reassign
let salesMgr: U; // a Sales Dashboard manager: may set areas, may not move books
let salesman: U;
let holder: U; // whose book the shops are in today

async function makeUser(name: string, level: Level, apps: [string, Level][]) {
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

async function shop(over: Partial<typeof customers.$inferInsert>) {
  const [r] = await db
    .insert(customers)
    .values({ id: id("cus"), name: `Shop ${randomUUID().slice(0, 6)}`, phone: testPhone(), city: "Pune", territoryRegion: "Maharashtra", kind: "customer", salesAmId: holder.id, ownerId: holder.id, ...over })
    .returning();
  return r;
}

const PUNE = [
  { kind: "state", value: "Maharashtra", parent: "" },
  { kind: "city", value: "Pune", parent: "Maharashtra" },
];
const seat = async (cid: string) => {
  const [r] = await db.select({ kind: customers.kind, owner: customers.ownerId, sales: customers.salesAmId }).from(customers).where(eq(customers.id, cid));
  return r.kind === "lead" ? r.owner : r.sales;
};
const areasOf = async (uid: string) => (await db.select().from(mbosUserTerritories).where(eq(mbosUserTerritories.userId, uid))).map((t) => `${t.kind}:${t.region}`).sort();

/* The action ends with `revalidatePath`, which throws outside a Next request
   once the work is done — the same allowance sales-manager-pipeline makes. */
const saved = (r: { ok: boolean; error?: string }) => r.ok || /static generation store/.test(r.error ?? "");

let inPune: string[];
let nashik: string;
let closed: string;

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});
after(async () => {
  setTestUser(null);
  await db.$client.end();
});
beforeEach(async () => {
  await db.execute(sql`
    truncate table customer_am_changes, notifications, timeline_events, audit_log, app_module_access, app_access,
      mbos_user_territories, customers, users, app_settings restart identity cascade`);
  invalidateConfig();
  await seedConfig();
  admin = await makeUser("Pritesh Admin", "admin", [["sales", "admin"]]);
  salesMgr = await makeUser("Sunil Sales Manager", "manager", [["sales", "manager"]]);
  salesman = await makeUser("Prashant Field", "associate", [["field", "associate"]]);
  holder = await makeUser("Seema Holder", "associate", [["crm", "associate"]]);
  inPune = [
    (await shop({})).id,
    (await shop({})).id,
    (await shop({ kind: "lead", salesAmId: null })).id,
  ];
  nashik = (await shop({ city: "Nashik" })).id;
  closed = (await shop({ status: "deactivated" })).id;
});

describe("the hand-over that comes with an area", () => {
  test("the preview counts the shops in the areas held by somebody else, and from whom", async () => {
    setTestUser(admin);
    const r = await previewAreaHandover({ salesmanId: salesman.id, territories: PUNE });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.data.total, 3);
    assert.deepEqual(r.data.from, [{ name: "Seema Holder", customers: 2, leads: 1 }]);
    assert.equal(r.data.canMove, true);
  });

  test("saving with the count shown moves exactly those shops, with history", async () => {
    setTestUser(admin);
    const r = await setSalesmanTerritories({ salesmanId: salesman.id, territories: PUNE, handOver: 3 });
    assert.ok(saved(r), JSON.stringify(r));
    for (const cid of inPune) assert.equal(await seat(cid), salesman.id);
    assert.equal(await seat(nashik), holder.id, "outside the areas");
    assert.equal(await seat(closed), holder.id, "deactivated");
    const history = await db.select().from(customerAmChanges).where(inArray(customerAmChanges.customerId, inPune));
    assert.equal(history.length, 3);
    assert.ok(history.every((h) => h.toUserId === salesman.id && h.fromUserId === holder.id && h.changedById === admin.id));
    assert.deepEqual(await areasOf(salesman.id), ["city:Pune"]);
  });

  test("a count that no longer matches moves nothing and saves nothing", async () => {
    setTestUser(admin);
    const r = await setSalesmanTerritories({ salesmanId: salesman.id, territories: PUNE, handOver: 2 });
    assert.ok(!r.ok && r.code === "conflict", JSON.stringify(r));
    for (const cid of inPune) assert.equal(await seat(cid), holder.id);
    assert.deepEqual(await areasOf(salesman.id), []);
  });

  test("areas already set still hand over their shops", async () => {
    setTestUser(admin);
    assert.ok(saved(await setSalesmanTerritories({ salesmanId: salesman.id, territories: PUNE })));
    for (const cid of inPune) assert.equal(await seat(cid), holder.id, "a plain save moves nothing");
    const r = await setSalesmanTerritories({ salesmanId: salesman.id, territories: PUNE, handOver: 3 });
    assert.ok(saved(r), JSON.stringify(r));
    for (const cid of inPune) assert.equal(await seat(cid), salesman.id);
  });

  test("a sales manager sets the areas but cannot move the books", async () => {
    setTestUser(salesMgr);
    const p = await previewAreaHandover({ salesmanId: salesman.id, territories: PUNE });
    assert.ok(p.ok, JSON.stringify(p));
    assert.equal(p.data.canMove, false);
    const refused = await setSalesmanTerritories({ salesmanId: salesman.id, territories: PUNE, handOver: 3 });
    assert.ok(!refused.ok && !/static generation store/.test(refused.error), JSON.stringify(refused));
    for (const cid of inPune) assert.equal(await seat(cid), holder.id);
    assert.ok(saved(await setSalesmanTerritories({ salesmanId: salesman.id, territories: PUNE })));
    assert.deepEqual(await areasOf(salesman.id), ["city:Pune"]);
  });
});
