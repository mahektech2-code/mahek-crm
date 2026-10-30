/**
 * ONE PRICE LIST PER SHOP, AND LEAVING SHOPS OUT — END TO END.
 *
 * The rule itself is `engines/price-one-list.test.ts`. These prove the writes
 * refuse a second list, that each answer (keep where it is, move here) is
 * written the way the screens promise, that doubles stored before the rule
 * are settled without a price moving, and that the setting turns it off.
 *
 * (The paragraph below is the price-list suite's, whose fixtures this shares.)
 *
 * PRICE LISTS, END TO END.
 *
 * The engines are proved pure in `engines/price-lists.test.ts` and the reader
 * against the four real documents in `price-list-parse.test.ts`. What only a
 * database can show is the part in between: that publishing supersedes and
 * dates out, that a derived list reproduces the list Mahek actually issued,
 * that the hierarchy picks the same shop's list through the real service, and
 * that somebody without the capability cannot publish one.
 *
 *   npm run test:integration
 *
 * They need mahekone_test, which `npm run test:db` creates from the committed
 * migrations. The harness truncates between tests.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  customers,
  finishedGoods,
  priceListScopes,
  productBrands,
  productFormulations,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";

import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { addDays } from "@/lib/business-date";

import {
  addScope,
  createPriceList,
  publishPriceList,
  setRate,
} from "@/lib/actions/price-lists";
import { assignCustomerList } from "@/lib/actions/price-lists";
import { settleAllToTodaysList, shopsOnTwoLists, previewListRules } from "@/lib/actions/price-one-list";
import {
  resolveForCustomer,
} from "@/lib/services/price-list-service";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let TODAY: string;
let manager: typeof users.$inferSelect;
let telecaller: typeof users.$inferSelect;
/** The two SKUs every case below is priced on: Nano Thinner 20 L and 5 L. */
let nano20: typeof products.$inferSelect;
let nano5: typeof products.$inferSelect;

async function makeUser(
  name: string,
  role: "associate" | "manager",
  app: "crm" | "sales" | "accounts" | "founder" = "crm",
  alsoApp?: "accounts" | "founder",
) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role });
  if (alsoApp) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: alsoApp, role });
  return row;
}

async function makeProduct(name: string, millilitres: number, cansPerBox: number, packing: string) {
  const formulationId = id("fml");
  const brandId = id("brn");
  const fgId = id("fgd");
  await db.insert(productFormulations).values({ id: formulationId, name: `F ${name}`, slug: id("s") });
  await db.insert(productBrands).values({ id: brandId, name: name.split(" - ")[0], slug: id("s"), formulationId });
  await db.insert(finishedGoods).values({
    id: fgId,
    name: name.split(" (")[0],
    slug: id("s"),
    brandId,
    formulationId,
    millilitres,
  });
  const [row] = await db
    .insert(products)
    .values({
      id: id("prd"),
      name,
      millilitresPerCan: millilitres,
      cansPerBox,
      packing,
      finishedGoodId: fgId,
      brandId,
      formulationId,
    })
    .returning();
  return row;
}

async function makeCustomer(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: over.name ?? `Shop ${randomUUID().slice(0, 6)}`,
      contactPerson: "Contact",
      phone: testPhone(),
      city: "Thane",
      region: "Maharashtra",
      kind: "customer",
      ownerId: telecaller.id,
      salesAmId: telecaller.id,
      ...over,
    })
    .returning();
  return row;
}

/** A published list on one state, with the two Nano rates on it. */
async function publishStateList(input: {
  name: string;
  state: string;
  freightTerm?: "to_pay" | "paid" | "not_stated";
  inclTwenty: number;
  inclFive: number;
  effectiveFrom?: string;
}) {
  setTestUser(manager);
  const created = await createPriceList({
    name: input.name,
    effectiveFrom: input.effectiveFrom ?? addDays(TODAY, -30),
    freightTerm: input.freightTerm ?? "not_stated",
    deliveryBasis: "for_mumbai",
  });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const listId = created.data.id;
  for (const [product, incl] of [
    [nano20, input.inclTwenty],
    [nano5, input.inclFive],
  ] as const) {
    const r = await setRate({ priceListId: listId, productId: product.id, rateInclGstPaise: incl });
    assert.ok(r.ok, r.ok ? "" : r.error);
  }
  const scoped = await addScope({
    priceListId: listId,
    scopeKind: "state",
    scopeValue: input.state,
    scopeLabel: input.state,
    freightTermMatch: input.freightTerm && input.freightTerm !== "not_stated" ? input.freightTerm : "any",
  });
  assert.ok(scoped.ok, scoped.ok ? "" : scoped.error);
  const published = await publishPriceList(listId);
  assert.ok(published.ok, published.ok ? "" : published.error);
  return listId;
}

before(async () => {
  await seedConfig();
  TODAY = await today();
});

/*
 * Close the pool, as every other integration suite does. Without it the run's
 * last test passes and node then waits on idle connections until Postgres
 * drops them — about an hour in CI, twice, for these two suites.
 */
after(async () => {
  setTestUser(null);
  await db.$client.end();
});

beforeEach(async () => {
  /* Every suite here truncates the tables it touches — there is one test
   * database and the runner takes the files one at a time. Without it the
   * second test in this file collides on `users_email_key`. */
  await db.execute(sql`
    truncate table
      price_list_parse_rows, price_list_rates, price_list_scopes,
      price_list_discount_terms, price_requests, price_lists,
      price_list_documents,
      audit_log, notifications, orders, calls,
      interaction_product_lines, sheet_order_rows, sheet_sync_runs,
      app_access, sessions, customers, users,
      products, finished_goods, product_brands, product_formulations,
      app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  /* A sales manager for the team scope, AND the Accounts desk for the price
   * desk — a Sales Dashboard manager alone may no longer change a price list
   * (see `PRICE_DESK` in access-control.ts). */
  manager = await makeUser("Vikram", "manager", "sales", "accounts");
  telecaller = await makeUser("Priya", "associate", "crm");
  /* The telecaller reports to the manager, which is what makes her book part
   * of his team's. Without it a manager cannot open a customer she owns —
   * true of the real hierarchy, and the reason a fixture has to state it. */
  await db.update(users).set({ reportsToId: manager.id }).where(eq(users.id, telecaller.id));
  nano20 = await makeProduct("Nano Thinner - 20 Liter (2 Can/Box)", 20000, 2, "2 Can/Box");
  nano5 = await makeProduct("Nano Thinner - 5 Liter (6 Can/Box)", 5000, 6, "6 Can/Box");
  setTestUser(manager);
});


const THANE = "thane";
const MH = "maharashtra";

async function draftCityList(name: string, city = THANE) {
  const created = await createPriceList({ name, effectiveFrom: addDays(TODAY, -10), freightTerm: "not_stated", deliveryBasis: "for_mumbai" });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const listId = created.data.id;
  const r = await setRate({ priceListId: listId, productId: nano20.id, rateInclGstPaise: 250000 });
  assert.ok(r.ok, r.ok ? "" : r.error);
  const s = await addScope({ priceListId: listId, scopeKind: "city", scopeValue: city, scopeLabel: "Thane", parentKey: "" });
  assert.ok(s.ok, s.ok ? "" : s.error);
  return listId;
}

describe("one price list per shop", () => {
  test("publishing a list that would put shops on a second list is refused, and leaving them out lets it through", async () => {
    const state = await publishStateList({ name: "Maharashtra", state: MH, inclTwenty: 230000, inclFive: 60000 });
    const a = await makeCustomer({ name: "Alpha Paints" });
    const b = await makeCustomer({ name: "Beta Paints" });

    const thane = await draftCityList("Thane Dealers");
    const refused = await publishPriceList(thane);
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.error, /Alpha Paints|Beta Paints|2 shops/);

    for (const c of [a, b]) {
      const out = await addScope({ priceListId: thane, scopeKind: "customer", scopeValue: c.id, scopeLabel: c.name, excluded: true });
      assert.ok(out.ok, out.ok ? "" : out.error);
    }
    const published = await publishPriceList(thane);
    assert.ok(published.ok, published.ok ? "" : published.error);
    assert.equal((await resolveForCustomer(a.id, TODAY))!.listId, state);
    assert.equal((await resolveForCustomer(b.id, TODAY))!.listId, state);
  });

  test("adding a shop to a live list asks; 'move here' takes it off the other list", async () => {
    const state = await publishStateList({ name: "Maharashtra", state: MH, inclTwenty: 230000, inclFive: 60000 });
    const a = await makeCustomer({ name: "Alpha Paints", city: "Pune" });
    const pune = await createPriceList({ name: "Pune Dealers", effectiveFrom: addDays(TODAY, -10), freightTerm: "not_stated", deliveryBasis: "for_mumbai" });
    assert.ok(pune.ok);
    assert.ok((await setRate({ priceListId: pune.data.id, productId: nano20.id, rateInclGstPaise: 240000 })).ok);
    assert.ok((await addScope({ priceListId: pune.data.id, scopeKind: "city", scopeValue: "nowhere", parentKey: "" })).ok);
    assert.ok((await publishPriceList(pune.data.id)).ok);

    const asked = await addScope({ priceListId: pune.data.id, scopeKind: "customer", scopeValue: a.id, scopeLabel: a.name });
    assert.equal(asked.ok, false, "a shop on Maharashtra cannot also be put on Pune Dealers unanswered");

    const preview = await previewListRules({ listId: pune.data.id, withSavedRows: true, rows: [{ scopeKind: "customer", scopeValue: a.id, parentKey: "" }] });
    assert.ok(preview.ok);
    assert.deepEqual(preview.data.clashes.map((c) => c.customerId), [a.id]);
    const bookId = preview.data.clashes[0].others[0].bookId;

    const moved = await addScope(
      { priceListId: pune.data.id, scopeKind: "customer", scopeValue: a.id, scopeLabel: a.name },
      [{ customerId: a.id, answer: "move", otherBookId: bookId }],
    );
    assert.ok(moved.ok, moved.ok ? "" : moved.error);
    assert.equal((await resolveForCustomer(a.id, TODAY))!.listId, pune.data.id);
    const left = await db.select().from(priceListScopes).where(eq(priceListScopes.priceListId, state));
    assert.ok(left.some((s) => s.excluded && s.scopeValue === a.id), "Maharashtra now leaves the shop out");
  });

  test("shops already on two lists are listed, and settling keeps today's price", async () => {
    const state = await publishStateList({ name: "Maharashtra", state: MH, inclTwenty: 230000, inclFive: 60000 });
    const a = await makeCustomer({ name: "Alpha Paints" });
    const thane = await draftCityList("Thane Dealers");
    await db.execute(sql`update app_settings set value = 'false'::jsonb where key = 'pricing.oneListPerShop'`);
    invalidateConfig();
    assert.ok((await publishPriceList(thane)).ok, "with the rule off, a double is allowed");
    await db.execute(sql`delete from app_settings where key = 'pricing.oneListPerShop'`);
    invalidateConfig();
    await seedConfig();

    const before = (await resolveForCustomer(a.id, TODAY))!.listId;
    assert.equal(before, thane, "the narrower list prices the shop today");
    const listed = await shopsOnTwoLists();
    assert.ok(listed.ok);
    assert.deepEqual(listed.data.map((s) => s.customerId), [a.id]);

    const settled = await settleAllToTodaysList();
    assert.ok(settled.ok, settled.ok ? "" : settled.error);
    assert.equal(settled.data.settled, 1);
    assert.equal((await resolveForCustomer(a.id, TODAY))!.listId, thane, "no price moved");
    const after2 = await shopsOnTwoLists();
    assert.ok(after2.ok);
    assert.equal(after2.data.length, 0);
    void state;
  });

  test("putting a shop on a list from its own page takes it off every other list", async () => {
    const state = await publishStateList({ name: "Maharashtra", state: MH, inclTwenty: 230000, inclFive: 60000 });
    const a = await makeCustomer({ name: "Alpha Paints" });
    const thane = await draftCityList("Thane Dealers");
    assert.ok((await addScope({ priceListId: thane, scopeKind: "customer", scopeValue: a.id, excluded: true })).ok);
    assert.ok((await publishPriceList(thane)).ok);

    const r = await assignCustomerList({ customerId: a.id, priceListId: thane });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal((await resolveForCustomer(a.id, TODAY))!.listId, thane);
    const listed = await shopsOnTwoLists();
    assert.ok(listed.ok);
    assert.equal(listed.data.length, 0, "Maharashtra leaves it out, so it is on one list");
    void state;
  });
});
