/**
 * OVERRIDES — a special price with dates, applied through the shop's agreed
 * list on the days it starts and ends, against the real database and the real
 * actions. The sync is run for each day the way the hourly job would.
 *
 *   npm run test:integration   (needs mahekone_test — `npm run test:db`)
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
  priceListRates,
  priceListScopes,
  priceLists,
  priceOverrides,
  priceRequests,
  productBrands,
  productFormulations,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { addDays } from "@/lib/business-date";
import { AGREED_SCOPE_PRIORITY } from "@/lib/engines/price-resolution";
import { addScope, createPriceList, decidePriceRequest, publishPriceList, requestSpecialPrice, setRate } from "@/lib/actions/price-lists";
import { cancelOverride, createOverride, endOverride, extendOverride, requestContextAction } from "@/lib/actions/price-overrides";
import { ratesForCustomer } from "@/lib/services/price-list-service";
import { remindEndingOverrides, shopPricesView, syncAllOverrides, syncShopOverrides } from "@/lib/services/price-override-service";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

let TODAY: string;
let desk: typeof users.$inferSelect;
let telecaller: typeof users.$inferSelect;
let nano20: typeof products.$inferSelect;
let nano5: typeof products.$inferSelect;

async function makeUser(name: string, role: "associate" | "manager", apps: Array<"crm" | "accounts">) {
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
  for (const app of apps) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role });
  return row;
}

async function makeProduct(name: string, millilitres: number, cansPerBox: number) {
  const formulationId = id("fml");
  const brandId = id("brn");
  const fgId = id("fgd");
  await db.insert(productFormulations).values({ id: formulationId, name: `F ${name}`, slug: id("s") });
  await db.insert(productBrands).values({ id: brandId, name: "Nano Thinner", slug: id("s"), formulationId });
  await db.insert(finishedGoods).values({ id: fgId, name: name.split(" (")[0], slug: id("s"), brandId, formulationId, millilitres });
  const [row] = await db
    .insert(products)
    .values({ id: id("prd"), name, millilitresPerCan: millilitres, cansPerBox, packing: `${cansPerBox} Can/Box`, finishedGoodId: fgId, brandId, formulationId })
    .returning();
  return row;
}

async function makeShop(name = `Shop ${randomUUID().slice(0, 6)}`) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name,
      contactPerson: "Contact",
      phone: testPhone(),
      city: "Thane",
      region: "Maharashtra",
      kind: "customer",
      ownerId: telecaller.id,
      salesAmId: telecaller.id,
    })
    .returning();
  return row;
}

/** A published Maharashtra book, live since 40 days ago. */
async function liveBook(): Promise<string> {
  setTestUser(desk);
  const created = await createPriceList({ name: "Maharashtra", effectiveFrom: addDays(TODAY, -40), freightTerm: "not_stated", deliveryBasis: "for_mumbai" });
  assert.ok(created.ok, created.ok ? "" : created.error);
  for (const [product, incl] of [
    [nano20, 228_600],
    [nano5, 58_400],
  ] as const) {
    const r = await setRate({ priceListId: created.data.id, productId: product.id, rateInclGstPaise: incl });
    assert.ok(r.ok, r.ok ? "" : r.error);
  }
  assert.ok((await addScope({ priceListId: created.data.id, scopeKind: "state", scopeValue: key("Maharashtra"), scopeLabel: "Maharashtra" })).ok);
  assert.ok((await publishPriceList(created.data.id)).ok);
  return created.data.id;
}

/** An agreed list typed by hand before overrides existed: one rate, no override behind it. */
async function handTypedAgreed(customerId: string, productId: string, incl: number): Promise<string> {
  const listId = id("pl");
  await db.insert(priceLists).values({
    id: listId,
    name: "Hand typed — agreed prices",
    version: 1,
    kind: "agreed",
    effectiveFrom: addDays(TODAY, -10),
    taxBasis: "inclusive",
    gstBp: 1800,
    freightTerm: "not_stated",
    status: "published",
    publishedAt: new Date(),
  });
  await db.insert(priceListRates).values({
    id: id("plr"),
    priceListId: listId,
    productId,
    rateExGstPaise: Math.round(incl / 1.18),
    rateInclGstPaise: incl,
    matchStatus: "manual",
  });
  await db.insert(priceListScopes).values({
    id: id("pls"),
    priceListId: listId,
    scopeKind: "customer",
    scopeValue: customerId,
    freightTermMatch: "any",
    priority: AGREED_SCOPE_PRIORITY,
  });
  return listId;
}

const incl = async (customerId: string, productId: string, day: string) =>
  (await ratesForCustomer(customerId, [productId], day))[productId]?.rateInclGstPaise ?? null;

const agreedCount = async () =>
  Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from price_lists where kind = 'agreed'`))[0].n);

before(async () => {
  await seedConfig();
  TODAY = await today();
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      price_change_events, price_changes, price_ai_runs, price_overrides, price_book_findings,
      price_list_parse_rows, price_list_rates, price_list_scopes,
      price_list_discount_terms, price_requests, price_lists,
      price_list_documents,
      audit_log, notifications, attachments, orders, calls,
      interaction_product_lines, sheet_order_rows, sheet_sync_runs,
      app_access, sessions, customers, users,
      products, finished_goods, product_brands, product_formulations,
      app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  desk = await makeUser("Deepa", "manager", ["accounts"]);
  telecaller = await makeUser("Priya", "associate", ["crm"]);
  nano20 = await makeProduct("Nano Thinner - 20 Liter (2 Can/Box)", 20000, 2);
  nano5 = await makeProduct("Nano Thinner - 5 Liter (6 Can/Box)", 5000, 6);
  setTestUser(desk);
});

describe("an override starting later", () => {
  test("the shop pays the book until its day, the special price from it, and the book again after it ends", async () => {
    await liveBook();
    const shop = await makeShop();
    const made = await createOverride({
      customerId: shop.id,
      productId: nano20.id,
      rateInclGstPaise: 210_000,
      validFrom: addDays(TODAY, 5),
      validTo: addDays(TODAY, 20),
      minCansPerMonth: 40,
      note: "Diwali stock-up",
    });
    assert.ok(made.ok, made.ok ? "" : made.error);
    assert.equal(await agreedCount(), 0, "nothing to price yet, so no agreed list");
    assert.equal(await incl(shop.id, nano20.id, TODAY), 228_600);

    await syncShopOverrides(shop.id, addDays(TODAY, 4), null);
    assert.equal(await agreedCount(), 0);
    assert.equal(await incl(shop.id, nano20.id, addDays(TODAY, 4)), 228_600);

    const started = await syncShopOverrides(shop.id, addDays(TODAY, 5), null);
    assert.equal(started.changed, true);
    assert.equal(await incl(shop.id, nano20.id, addDays(TODAY, 5)), 210_000);
    assert.equal(await incl(shop.id, nano20.id, addDays(TODAY, 4)), 228_600, "the day before still pays the book");
    assert.equal(await incl(shop.id, nano5.id, addDays(TODAY, 5)), 58_400, "everything else falls through to the book");

    // Run again on the same day: nothing to do, nothing written.
    const lists = await db.select().from(priceLists);
    const again = await syncShopOverrides(shop.id, addDays(TODAY, 5), null);
    assert.equal(again.changed, false);
    assert.equal((await db.select().from(priceLists)).length, lists.length);
    const all = await syncAllOverrides(addDays(TODAY, 5));
    assert.equal(all.changed, 0);

    const [o] = await db.select().from(priceOverrides).where(eq(priceOverrides.customerId, shop.id));
    assert.equal(o.agreedListId, started.bookId);

    // The day after its last day, the shop is on the book — and the days it held still read as they were.
    await syncShopOverrides(shop.id, addDays(TODAY, 21), null);
    assert.equal(await incl(shop.id, nano20.id, addDays(TODAY, 21)), 228_600);
    assert.equal(await incl(shop.id, nano20.id, addDays(TODAY, 10)), 210_000, "history stays explainable");
  });
});

describe("ending one override", () => {
  test("that product falls back to the book; a hand-typed agreed rate stays", async () => {
    await liveBook();
    const shop = await makeShop();
    await handTypedAgreed(shop.id, nano5.id, 50_000);
    assert.equal(await incl(shop.id, nano5.id, TODAY), 50_000);

    const made = await createOverride({
      customerId: shop.id,
      productId: nano20.id,
      rateInclGstPaise: 210_000,
      validFrom: TODAY,
      validTo: null,
      minCansPerMonth: null,
      note: "",
    });
    assert.ok(made.ok, made.ok ? "" : made.error);
    assert.equal(await incl(shop.id, nano20.id, TODAY), 210_000, "applied at once");
    assert.equal(await incl(shop.id, nano5.id, TODAY), 50_000, "the hand-typed rate is kept");
    assert.equal(await agreedCount(), 2, "a new revision of the same book, not a second agreed list");
    const books = await db.execute<{ n: number }>(sql`select count(distinct book_id)::int as n from price_lists where kind = 'agreed'`);
    assert.equal(Number(books[0].n), 1);

    const ended = await endOverride(made.data.id, TODAY, "Volume did not come");
    assert.ok(ended.ok, ended.ok ? "" : ended.error);
    assert.equal(await incl(shop.id, nano20.id, TODAY), 210_000, "still applies on its last day");
    await syncShopOverrides(shop.id, addDays(TODAY, 1), null);
    assert.equal(await incl(shop.id, nano20.id, addDays(TODAY, 1)), 228_600);
    assert.equal(await incl(shop.id, nano5.id, addDays(TODAY, 1)), 50_000, "never removed");
  });

  test("cancelling takes it off at once; extending moves the end and asks to be reminded again", async () => {
    await liveBook();
    const shop = await makeShop();
    const made = await createOverride({ customerId: shop.id, productId: nano20.id, rateInclGstPaise: 215_000, validFrom: TODAY, validTo: addDays(TODAY, 3), minCansPerMonth: null, note: "" });
    assert.ok(made.ok);
    assert.equal(await remindEndingOverrides(TODAY), 1);
    assert.equal(await remindEndingOverrides(TODAY), 0, "once");
    assert.ok((await extendOverride(made.data.id, addDays(TODAY, 60))).ok);
    const [row] = await db.select().from(priceOverrides).where(eq(priceOverrides.id, made.data.id));
    assert.equal(row.validTo, addDays(TODAY, 60));
    assert.equal(row.remindedAt, null);

    const cancelled = await cancelOverride(made.data.id, "Entered on the wrong shop");
    assert.ok(cancelled.ok);
    assert.equal(await incl(shop.id, nano20.id, TODAY), 228_600);
    const refused = await createOverride({ customerId: shop.id, productId: nano20.id, rateInclGstPaise: 0, validFrom: TODAY, validTo: null, minCansPerMonth: null, note: "" });
    assert.equal(refused.ok, false);
  });
});

describe("a special-price request", () => {
  async function ask(customerId: string, inclPaise: number) {
    setTestUser(telecaller);
    const asked = await requestSpecialPrice({ customerId, productId: nano20.id, requestedRateInclGstPaise: inclPaise, reason: "Taking a hundred cans" });
    assert.ok(asked.ok, asked.ok ? "" : asked.error);
    setTestUser(desk);
    return asked.data.id;
  }

  test("approved as an override with dates, a minimum and a counter price", async () => {
    await liveBook();
    const shop = await makeShop();
    await makeShop(); // a neighbour in Thane
    const requestId = await ask(shop.id, 205_000);

    const context = await requestContextAction(requestId);
    assert.ok(context.ok, context.ok ? "" : context.error);
    assert.equal(context.data.facts.book?.incl, 228_600);
    assert.equal(context.data.facts.payToday?.incl, 228_600);
    assert.equal(context.data.facts.nearby.shops, 1);

    setTestUser(telecaller);
    const theirs = await requestContextAction(requestId);
    assert.ok(theirs.ok, "the person who asked reads it");
    const other = await makeUser("Rakesh", "associate", ["crm"]);
    setTestUser(other);
    assert.equal((await requestContextAction(requestId)).ok, false, "nobody else does");
    setTestUser(desk);

    const decided = await decidePriceRequest(requestId, {
      decision: "approved",
      note: "Until the end of the quarter",
      validFrom: TODAY,
      validTo: addDays(TODAY, 30),
      minCansPerMonth: 50,
      counterRateInclGstPaise: 215_000,
    });
    assert.ok(decided.ok, decided.ok ? "" : decided.error);
    assert.ok(decided.data.listId);
    assert.equal(await incl(shop.id, nano20.id, TODAY), 215_000, "the counter price, not the one asked");

    const [o] = await db.select().from(priceOverrides).where(eq(priceOverrides.requestId, requestId));
    assert.equal(o.validTo, addDays(TODAY, 30));
    assert.equal(o.minCansPerMonth, 50);
    assert.equal(o.rateInclGstPaise, 215_000);
    const [q] = await db.select().from(priceRequests).where(eq(priceRequests.id, requestId));
    assert.equal(q.status, "approved");
    assert.equal(q.resultingListId, decided.data.listId);

    await syncShopOverrides(shop.id, addDays(TODAY, 31), null);
    assert.equal(await incl(shop.id, nano20.id, addDays(TODAY, 31)), 228_600, "it ends when it said it would");

    const view = await shopPricesView(shop.id);
    assert.ok(view);
    const row = view.rows.find((r) => r.productId === nano20.id)!;
    assert.equal(row.source, "override");
    assert.equal(row.bookIncl, 228_600);
    assert.equal(view.rows.find((r) => r.productId === nano5.id)!.source, "book");
  });

  test("the old approve, with no dates, still puts the shop on its price from today and keeps the agreed book", async () => {
    await liveBook();
    const shop = await makeShop();
    const first = await decidePriceRequest(await ask(shop.id, 210_000), { decision: "approved" });
    assert.ok(first.ok, first.ok ? "" : first.error);
    assert.equal(await incl(shop.id, nano20.id, TODAY), 210_000);
    const second = await decidePriceRequest(await ask(shop.id, 205_000), { decision: "approved" });
    assert.ok(second.ok, second.ok ? "" : second.error);
    assert.equal(second.data.listId, first.data.listId, "the same agreed book");
    assert.equal(await incl(shop.id, nano20.id, TODAY), 205_000, "the newest approval wins");
    const rows = await db.select().from(priceOverrides).where(eq(priceOverrides.customerId, shop.id));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.validTo == null));
  });
});
