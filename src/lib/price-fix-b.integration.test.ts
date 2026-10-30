/**
 * HOW A PRICE IS RESOLVED AND READ, against a real database.
 *
 * The pure half is `engines/price-fix-b.test.ts`. This is the wiring: that a
 * shop on a one-rate agreed list keeps its other prices through the real
 * service, that the validity setting moves the resolver and the screens
 * together, that variance reads a superseded version on its own dates and is
 * narrowed to the reader's book, that a salesman list names the sales seat
 * and not the importer, that a routine revision does not read as "their list
 * changed", that a slab is taken by quantity, and that the rates route asks
 * the customer's scope.
 *
 *   npm run test:integration
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appSettings,
  customers,
  finishedGoods,
  orders,
  productBrands,
  productFormulations,
  products,
  sheetOrderRows,
  sheetSyncRuns,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { addDays } from "@/lib/business-date";
import { exFromIncl } from "@/lib/engines/price-math";
import { addScope, createPriceList, publishPriceList, setRate } from "@/lib/actions/price-lists";
import {
  customerPricing,
  listPriceLists,
  ratesForCustomer,
  resolveForCustomer,
  varianceReport,
} from "@/lib/services/price-list-service";
import { GET as ratesRoute } from "@/app/api/price-lists/customers/[id]/rates/route";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

let TODAY: string;
let manager: typeof users.$inferSelect;
let telecaller: typeof users.$inferSelect;
let other: typeof users.$inferSelect;
let nano20: typeof products.$inferSelect;
let nano5: typeof products.$inferSelect;

async function makeUser(name: string, role: "associate" | "manager", app: "crm" | "sales" | "accounts", alsoApp?: "accounts") {
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
  await db.insert(finishedGoods).values({ id: fgId, name: name.split(" (")[0], slug: id("s"), brandId, formulationId, millilitres });
  const [row] = await db
    .insert(products)
    .values({ id: id("prd"), name, millilitresPerCan: millilitres, cansPerBox, packing, finishedGoodId: fgId, brandId, formulationId })
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

/** A published list with the given scope and rates. */
async function publishList(input: {
  name: string;
  scope: { kind: "state" | "customer" | "salesman" | "everybody"; value: string };
  rates: Array<{ product: typeof products.$inferSelect; incl: number; minCans?: number; maxCans?: number }>;
  effectiveFrom?: string;
  supersedesId?: string;
}) {
  setTestUser(manager);
  const created = await createPriceList({ name: input.name, effectiveFrom: input.effectiveFrom ?? addDays(TODAY, -10) });
  assert.ok(created.ok, created.ok ? "" : created.error);
  for (const r of input.rates) {
    const set = await setRate({
      priceListId: created.data.id,
      productId: r.product.id,
      rateInclGstPaise: r.incl,
      minCans: r.minCans ?? null,
      maxCans: r.maxCans ?? null,
    });
    assert.ok(set.ok, set.ok ? "" : set.error);
  }
  const scoped = await addScope({
    priceListId: created.data.id,
    scopeKind: input.scope.kind,
    scopeValue: input.scope.value,
    scopeLabel: input.scope.value,
  });
  assert.ok(scoped.ok, scoped.ok ? "" : scoped.error);
  const published = await publishPriceList(created.data.id, input.supersedesId ? { supersedesId: input.supersedesId } : undefined);
  assert.ok(published.ok, published.ok ? "" : published.error);
  return created.data.id;
}

async function setSetting(k: string, value: unknown) {
  await db.update(appSettings).set({ value }).where(eq(appSettings.key, k));
  invalidateConfig();
}

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
  manager = await makeUser("Vikram", "manager", "sales", "accounts");
  telecaller = await makeUser("Priya", "associate", "crm");
  other = await makeUser("Rakesh", "associate", "crm");
  await db.update(users).set({ reportsToId: manager.id }).where(eq(users.id, telecaller.id));
  await db.update(users).set({ reportsToId: manager.id }).where(eq(users.id, other.id));
  nano20 = await makeProduct("Nano Thinner - 20 Liter (2 Can/Box)", 20000, 2, "2 Can/Box");
  nano5 = await makeProduct("Nano Thinner - 5 Liter (6 Can/Box)", 5000, 6, "6 Can/Box");
  setTestUser(manager);
});

describe("a shop's prices fall through, product by product (B1)", () => {
  test("a one-rate agreed list keeps every other product's price from the list beneath it", async () => {
    const shop = await makeCustomer({ name: "Bharat Hardware" });
    const state = await publishList({
      name: "Pan Maharashtra",
      scope: { kind: "state", value: key("Maharashtra") },
      rates: [
        { product: nano20, incl: 228_600 },
        { product: nano5, incl: 58_400 },
      ],
    });
    const agreed = await publishList({
      name: "Bharat Hardware — agreed prices",
      scope: { kind: "customer", value: shop.id },
      rates: [{ product: nano20, incl: 210_000 }],
    });

    const resolution = await resolveForCustomer(shop.id, TODAY);
    assert.equal(resolution?.listId, agreed);
    assert.deepEqual(
      resolution?.candidates.map((c) => c.listId),
      [agreed, state],
    );

    const rates = await ratesForCustomer(shop.id, [nano20.id, nano5.id], TODAY);
    assert.equal(rates[nano20.id].listId, agreed);
    assert.equal(rates[nano20.id].rateInclGstPaise, 210_000);
    assert.equal(rates[nano20.id].fellThrough, false);
    assert.equal(rates[nano5.id].listId, state, "the product the agreed list lacks is priced from the state list");
    assert.equal(rates[nano5.id].listName, "Pan Maharashtra");
    assert.equal(rates[nano5.id].rateInclGstPaise, 58_400);
    assert.equal(rates[nano5.id].fellThrough, true);

    setTestUser(telecaller);
    const pricing = await customerPricing(shop.id, TODAY);
    assert.equal(pricing?.list?.id, agreed);
    const byProduct = new Map(pricing!.rates.map((r) => [r.productId, r]));
    assert.equal(byProduct.get(nano20.id)?.listId, agreed);
    assert.equal(byProduct.get(nano5.id)?.listId, state, "the Which-list panel says where each price came from");
    assert.equal(pricing!.rates.length, 2, "the state list's own Nano 20 L does not appear beside the agreed one");
  });
});

describe("slabs by quantity (B20)", () => {
  test("a quantity takes the slab it falls in; none takes the base row", async () => {
    const shop = await makeCustomer();
    await publishList({
      name: "Pan Maharashtra",
      scope: { kind: "state", value: key("Maharashtra") },
      rates: [
        { product: nano20, incl: 228_600 },
        { product: nano20, incl: 220_000, minCans: 10 },
      ],
    });
    const base = await ratesForCustomer(shop.id, [nano20.id], TODAY);
    assert.equal(base[nano20.id].rateInclGstPaise, 228_600);
    assert.equal(base[nano20.id].slabs.length, 2);
    const bulk = await ratesForCustomer(shop.id, [nano20.id], TODAY, { [nano20.id]: 12 });
    assert.equal(bulk[nano20.id].rateInclGstPaise, 220_000);
  });
});

describe("past validity, the setting and the screens (B5)", () => {
  test("by default a list past its validity still prices, and is said to; switched off it stops", async () => {
    const shop = await makeCustomer();
    const listId = await publishList({
      name: "Old Maharashtra",
      scope: { kind: "state", value: key("Maharashtra") },
      rates: [{ product: nano20, incl: 228_600 }],
      effectiveFrom: addDays(TODAY, -60),
    });

    assert.equal((await resolveForCustomer(shop.id, TODAY))?.listId, listId);
    let summary = (await listPriceLists({ status: "all" })).find((l) => l.id === listId)!;
    assert.equal(summary.expired, true);
    assert.equal(summary.validityState, "past_validity_pricing");

    await setSetting("pricing.expiredListsKeepPricing", false);
    assert.equal(await resolveForCustomer(shop.id, TODAY), null, "the resolver stops pricing from it");
    summary = (await listPriceLists({ status: "all" })).find((l) => l.id === listId)!;
    assert.equal(summary.validityState, "expired", "and the screens say it is not pricing");
  });
});

describe("variance (B6, B35)", () => {
  async function sheetLine(customerId: string | null, orderDate: string, ratePaise: number) {
    const syncId = id("syn");
    await db.insert(sheetSyncRuns).values({ id: syncId, source: "order", spreadsheetId: "t", tabTitle: "Order Details", mode: "append", status: "ok" });
    await db.insert(sheetOrderRows).values({
      id: id("sor"),
      syncId,
      rowNumber: 1,
      lineKey: id("lk"),
      orderNumber: id("ORD"),
      raw: {},
      rowHash: randomUUID(),
      status: "present",
      orderDate,
      billingPartyName: "x",
      description: nano20.name,
      cans: 4,
      ratePaise,
      matchedCustomerId: customerId,
      matchedProductId: nano20.id,
    });
  }

  test("a line before a revision is read against the version in force on its date", async () => {
    const shop = await makeCustomer();
    const lineDate = addDays(TODAY, -5);
    const v1 = await publishList({
      name: "Maharashtra",
      scope: { kind: "state", value: key("Maharashtra") },
      rates: [{ product: nano20, incl: 228_600 }],
      effectiveFrom: addDays(TODAY, -15),
    });
    const v2 = await publishList({
      name: "Maharashtra v2",
      scope: { kind: "state", value: key("Maharashtra") },
      rates: [{ product: nano20, incl: 240_000 }],
      effectiveFrom: TODAY,
      supersedesId: v1,
    });
    await sheetLine(shop.id, lineDate, exFromIncl(228_600, 1800));
    await sheetLine(shop.id, TODAY, exFromIncl(240_000, 1800));

    const months = [...new Set([lineDate.slice(0, 7), TODAY.slice(0, 7)])];
    const rows = (await Promise.all(months.map((m) => varianceReport(m)))).flatMap((r) => r.rows);
    const before = rows.find((r) => r.orderDate === lineDate)!;
    const now = rows.find((r) => r.orderDate === TODAY)!;
    assert.equal(before.listId, v1, "the superseded version answered for its own dates");
    assert.equal(before.deltaPaise, 0, "on list, not a false variance");
    assert.equal(now.listId, v2);
    assert.equal(now.deltaPaise, 0);
  });

  test("a telecaller sees only their own book's lines; a manager sees every line", async () => {
    await publishList({
      name: "Maharashtra",
      scope: { kind: "state", value: key("Maharashtra") },
      rates: [{ product: nano20, incl: 228_600 }],
    });
    const mine = await makeCustomer({ name: "Mine" });
    const theirs = await makeCustomer({ name: "Theirs", ownerId: other.id, salesAmId: other.id });
    await sheetLine(mine.id, TODAY, 180_000);
    await sheetLine(theirs.id, TODAY, 180_000);
    await sheetLine(null, TODAY, 180_000);

    setTestUser(telecaller);
    const narrowed = await varianceReport(TODAY.slice(0, 7));
    assert.deepEqual(
      narrowed.rows.map((r) => r.customerId),
      [mine.id],
    );

    /* The manager's team holds both books. (The sheet line no customer was
       matched to reaches only a reader who sees EVERY book.) */
    setTestUser(manager);
    const whole = await varianceReport(TODAY.slice(0, 7));
    const seen = new Set(whole.rows.map((r) => r.customerId));
    assert.ok(seen.has(mine.id) && seen.has(theirs.id));
  });
});

describe("a salesman list names the sales seat, never the importer (B18)", () => {
  test("a list for the person who ran the import does not catch the shops they own", async () => {
    const imported = await makeCustomer({ ownerId: other.id, salesAmId: telecaller.id });
    const listId = await publishList({
      name: "Rakesh's list",
      scope: { kind: "salesman", value: other.id },
      rates: [{ product: nano20, incl: 200_000 }],
    });
    assert.equal(await resolveForCustomer(imported.id, TODAY), null);
    const theirs = await makeCustomer({ ownerId: telecaller.id, salesAmId: other.id });
    assert.equal((await resolveForCustomer(theirs.id, TODAY))?.listId, listId);
  });
});

describe("“changed since their last order” follows the lineage (B19)", () => {
  test("a routine new version of the same list does not warn; a different list does", async () => {
    const shop = await makeCustomer();
    const v1 = await publishList({
      name: "Maharashtra",
      scope: { kind: "state", value: key("Maharashtra") },
      rates: [{ product: nano20, incl: 228_600 }],
      effectiveFrom: addDays(TODAY, -15),
    });
    await db.insert(orders).values({
      id: id("ord"),
      customerId: shop.id,
      orderedAt: new Date(`${addDays(TODAY, -3)}T09:00:00+05:30`),
      totalAmount: 0,
      priceListId: v1,
    });
    await publishList({
      name: "Maharashtra v2",
      scope: { kind: "state", value: key("Maharashtra") },
      rates: [{ product: nano20, incl: 240_000 }],
      effectiveFrom: TODAY,
      supersedesId: v1,
    });
    setTestUser(telecaller);
    assert.equal((await customerPricing(shop.id, TODAY))?.listChangedSinceLastOrder, false);

    setTestUser(manager);
    await publishList({
      name: "This shop",
      scope: { kind: "customer", value: shop.id },
      rates: [{ product: nano20, incl: 210_000 }],
    });
    setTestUser(telecaller);
    assert.equal((await customerPricing(shop.id, TODAY))?.listChangedSinceLastOrder, true);
  });
});

describe("the rates route asks the customer's scope (B28)", () => {
  test("a shop outside the caller's book answers not found", async () => {
    await publishList({
      name: "Maharashtra",
      scope: { kind: "state", value: key("Maharashtra") },
      rates: [{ product: nano20, incl: 228_600 }],
    });
    const mine = await makeCustomer();
    const theirs = await makeCustomer({ ownerId: other.id, salesAmId: other.id });
    setTestUser(telecaller);
    const call = (shopId: string) =>
      ratesRoute(new Request(`http://test/api/price-lists/customers/${shopId}/rates?products=${nano20.id}`), {
        params: Promise.resolve({ id: shopId }),
      });
    const ok = await call(mine.id);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json())[nano20.id].rateInclGstPaise, 228_600);
    assert.equal((await call(theirs.id)).status, 404);
  });
});
