/**
 * A field salesman's book — decided by his ACCOUNT, never by his name.
 *
 * This file used to pin a NAME LINK: shops reached a salesman's handset when
 * `customers.sales_person_name` (text off the party sheet) folded onto his
 * login's sheet spelling. Owner's rule, 2026-11-18: a person is their account
 * and a name decides nothing. The sheets are retired and every named
 * salesman's seat was filled from his name, so a shop now reaches him because
 * he is its sales seat (`sales_am_id`) — which, on a LEAD, the CRM's own
 * `ASSIGNED_TO_SQL` does not read (a lead answers to its owner), and that is
 * why the handset adds it.
 *
 * Pinned:
 *
 *   THE SEAT FILLS IT and a typed name alone reaches nobody's handset, however
 *   well it matches — the old rule turned back on would fail here.
 *
 *   A RENAME MOVES NOTHING. The same shops before and after.
 *
 *   IT DOES NOT LEAK, a manager sees his team's, an admin is unrestricted, and
 *   territory still only ever narrows.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, mbosUserTerritories, users } from "@/db/schema";
import { buildBootstrap } from "@/lib/services/mbos-service";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { scopedToUsers } from "@/lib/access-control";
import { customerIdsInScope, type MbosPrincipal } from "@/lib/services/mbos-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let salesman: typeof users.$inferSelect;
let other: typeof users.$inferSelect;
let telecaller: typeof users.$inferSelect;
let hisShops: string[];
let herShop: string;

function principalFor(user: typeof users.$inferSelect): MbosPrincipal {
  return {
    user,
    deviceId: "dev_test",
    role: "associate",
    scope: { kind: "own", userIds: [user.id] },
  };
}

async function makeUser(name: string, email: string) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email,
      passwordHash: "x",
      role: "associate",
      initials: "XX",
    })
    .returning();
  await db.insert(appAccess).values({ id: id("acc"), userId: row.id, app: "field" });
  /*
   * ALLOCATED, because an unallocated salesman now holds nothing at all and
   * every test in this file would pass for the wrong reason. That rule has its
   * own tests at the bottom; these are about the NAME LINK, and a fixture that
   * quietly answers "empty" to all of them would hide the day the link broke.
   */
  await db.insert(mbosUserTerritories).values({
    id: id("ut"),
    userId: row.id,
    kind: "state",
    region: "Maharashtra",
  });
  return row;
}

let phoneCounter = 9820000000;

/**
 * A LEAD a telecaller owns and a salesman works — the real shape, and the one
 * the CRM's book does not give him. `salesPersonName` is set to show that the
 * text is beside the point.
 */
async function makeShop(name: string, seat: string | null, salesPersonName: string | null = null) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name,
      phone: String(++phoneCounter),
      city: "Nagpur",
      region: "Maharashtra",
      kind: "lead",
      ownerId: telecaller.id,
      salesAmId: seat,
      salesPersonName,
    })
    .returning();
  return row.id;
}

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

after(async () => {
  await db.$client.end();
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table app_access, sessions, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  salesman = await makeUser("Mahesh Parab", "mahesh@test.local");
  other = await makeUser("Rahul Richhariya", "rahul@test.local");
  telecaller = await makeUser("Priya Calls", "priya@test.local");

  hisShops = [
    await makeShop("Sadar Paints", salesman.id, "  mahesh   PARAB "),
    await makeShop("Itwari Hardware", salesman.id),
  ];
  herShop = await makeShop("Dharampeth Colour", other.id, "Rahul Richhariya");
  await makeShop("Nobody's Shop", null);
});

const book = async (u: typeof users.$inferSelect) => [...(await customerIdsInScope(principalFor(u)))].sort();

describe("a field salesman's book", () => {
  test("the sales seat is what fills it", async () => {
    assert.deepEqual(await book(salesman), [...hisShops].sort());
  });

  test("a typed name alone reaches nobody's handset, however well it matches", async () => {
    const namedOnly = await makeShop("Name Only Paints", null, "Mahesh Parab");
    await db.update(users).set({ salesPersonName: "Mahesh Parab" }).where(eq(users.id, salesman.id));
    assert.ok(!(await book(salesman)).includes(namedOnly), "a name decides nothing");
  });

  test("a rename moves nothing", async () => {
    const before = await book(salesman);
    await db.update(users).set({ name: "Mahesh R. Parab" }).where(eq(users.id, salesman.id));
    assert.deepEqual(await book({ ...salesman, name: "Mahesh R. Parab" }), before);
  });

  test("one salesman's shops never reach another's handset", async () => {
    assert.ok(!(await book(salesman)).includes(herShop));
    assert.deepEqual(await book(other), [herShop]);
  });

  test("a manager on the handset sees his team's shops", async () => {
    const [manager] = await db
      .insert(users)
      .values({ id: id("usr"), name: "Vikram", email: "vikram@test.local", passwordHash: "x", role: "manager", initials: "V" })
      .returning();
    const ids = await customerIdsInScope({
      user: manager,
      deviceId: "dev_test",
      role: "manager",
      scope: { kind: "team", userIds: [manager.id, salesman.id, other.id] },
    });
    assert.deepEqual([...ids].sort(), [...hisShops, herShop].sort(), "a manager and his salesmen must not hold two different books");
  });

  test("an admin is still unrestricted", async () => {
    const [admin] = await db
      .insert(users)
      .values({ id: id("usr"), name: "Root", email: "root@test.local", passwordHash: "x", role: "admin", initials: "R" })
      .returning();
    const ids = await customerIdsInScope({ user: admin, deviceId: "dev_test", role: "admin", scope: { kind: "all", userIds: null } });
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(customers);
    assert.equal(ids.length, n);
  });

  test("NO AREA ALLOCATED MEANS NO BOOK — and the pull says so", async () => {
    await db.delete(mbosUserTerritories).where(eq(mbosUserTerritories.userId, salesman.id));
    assert.deepEqual(await book(salesman), [], "a salesman with nowhere allocated holds nothing");
    const boot = await buildBootstrap(principalFor(salesman));
    assert.deepEqual(boot.bookIds, [], "the pull must STATE the empty book");
  });

  test("WITH NO AREA, a shop he opened in the field stays in his book — and nothing else does", async () => {
    await db.delete(mbosUserTerritories).where(eq(mbosUserTerritories.userId, salesman.id));
    /* The shape `handleCustomerCreate` writes: `mbos` as its source, him as
       owner and sales seat. Before, the empty book deleted it on the next pull. */
    const [opened] = await db
      .insert(customers)
      .values({
        id: id("cus"),
        name: "Counter Paints",
        phone: String(++phoneCounter),
        city: "Wardha",
        kind: "customer",
        leadSource: "mbos",
        ownerId: salesman.id,
        salesAmId: salesman.id,
      })
      .returning({ id: customers.id });
    /* Another salesman's field shop is not his, area or no area. */
    await db.insert(customers).values({
      id: id("cus"),
      name: "Her Counter",
      phone: String(++phoneCounter),
      city: "Wardha",
      kind: "customer",
      leadSource: "mbos",
      ownerId: other.id,
      salesAmId: other.id,
    });
    assert.deepEqual(await book(salesman), [opened.id], "his own field shop, and none of his allocated book");
  });

  test("a city narrows INSIDE its state rather than beside it", async () => {
    const elsewhere = await makeShop("Pune Paints", salesman.id);
    await db.update(customers).set({ city: "Pune" }).where(eq(customers.id, elsewhere));
    await db.delete(mbosUserTerritories).where(eq(mbosUserTerritories.userId, salesman.id));
    await db.insert(mbosUserTerritories).values({ id: id("ut"), userId: salesman.id, kind: "city", region: "Pune", parent: "Maharashtra" });
    assert.deepEqual(await book(salesman), [elsewhere], "only the allocated city, not the whole state it sits in");
  });

  test("A MANAGER IS NOT NARROWED BY A RULE ABOUT BEATS", async () => {
    const [manager] = await db
      .insert(users)
      .values({ id: id("usr"), name: "Vikram", email: "vikram2@test.local", passwordHash: "x", role: "manager", initials: "V" })
      .returning();
    const ids = await customerIdsInScope({
      user: manager,
      deviceId: "dev_test",
      role: "manager",
      scope: { kind: "team", userIds: [manager.id, salesman.id] },
    });
    assert.deepEqual([...ids].sort(), [...hisShops].sort(), "no allocation, and still his team's book");
  });

  test("the CRM's own definition of whose book a lead is in does not move", async () => {
    /* A lead answers to its owner in the CRM; the sales seat is MBOS's
       question. Thirty-one CRM screens read `scopedToUsers`. */
    const rows = await db.select({ id: customers.id }).from(customers).where(scopedToUsers([salesman.id]));
    assert.deepEqual(rows, [], "the salesman's CRM book is the leads he OWNS, and he owns none");
  });
});
