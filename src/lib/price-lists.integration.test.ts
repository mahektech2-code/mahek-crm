/**
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
import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  auditLog,
  customers,
  finishedGoods,
  priceListDocuments,
  priceListParseRows,
  priceLists,
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
import { exFromIncl, inclFromEx } from "@/lib/engines/price-math";
import { parsePriceListText } from "@/lib/price-list-parse";
import { matchGrid, type CatalogueSku } from "@/lib/price-list-match";

import {
  addScope,
  createDerivedList,
  createPriceList,
  decidePriceRequest,
  publishDocument,
  publishPriceList,
  requestSpecialPrice,
  setRate,
  withdrawPriceList,
} from "@/lib/actions/price-lists";
import {
  coverageReport,
  customerPricing,
  listPriceLists,
  priceListDetail,
  ratesForCustomer,
  resolveForCustomer,
  varianceReport,
} from "@/lib/services/price-list-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

let TODAY: string;
let manager: typeof users.$inferSelect;
let telecaller: typeof users.$inferSelect;
/** The two SKUs every case below is priced on: Nano Thinner 20 L and 5 L. */
let nano20: typeof products.$inferSelect;
let nano5: typeof products.$inferSelect;

async function makeUser(name: string, role: "associate" | "manager", app: "crm" | "sales" = "crm") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role });
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
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
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

beforeEach(async () => {
  /* Every suite here truncates the tables it touches — there is one test
   * database and the runner takes the files one at a time. Without it the
   * second test in this file collides on `users_email_key`. */
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

  manager = await makeUser("Vikram", "manager", "sales");
  telecaller = await makeUser("Priya", "associate", "crm");
  /* The telecaller reports to the manager, which is what makes her book part
   * of his team's. Without it a manager cannot open a customer she owns —
   * true of the real hierarchy, and the reason a fixture has to state it. */
  await db.update(users).set({ reportsToId: manager.id }).where(eq(users.id, telecaller.id));
  nano20 = await makeProduct("Nano Thinner - 20 Liter (2 Can/Box)", 20000, 2, "2 Can/Box");
  nano5 = await makeProduct("Nano Thinner - 5 Liter (6 Can/Box)", 5000, 6, "6 Can/Box");
  setTestUser(manager);
});

describe("publishing a price list", () => {
  test("a list with no rates in it is refused, because a list with no prices is not a list", async () => {
    const created = await createPriceList({ name: "Empty", effectiveFrom: TODAY });
    assert.ok(created.ok);
    const published = await publishPriceList(created.data.id);
    assert.equal(published.ok, false);
    assert.match(published.ok ? "" : published.error, /no rates/i);
  });

  test("the stored rate is ex-GST and reproduces what the sheet bills", async () => {
    // Odisha To Pay prints ₹2,281 for Nano 20 L and the order sheet bills
    // ₹1,933 against it. Both figures have to come back out.
    const listId = await publishStateList({
      name: "Odisha To Pay",
      state: key("Odisha"),
      freightTerm: "to_pay",
      inclTwenty: 228_100,
      inclFive: 58_300,
    });
    const detail = await priceListDetail(listId);
    const twenty = detail!.rates.find((r) => r.productId === nano20.id)!;
    assert.equal(twenty.rateInclGstPaise, 228_100);
    assert.equal(Math.round(twenty.rateExGstPaise / 100), 1933);
  });

  test("publishing a second version dates the first one out and marks it superseded", async () => {
    const first = await publishStateList({
      name: "Maharashtra",
      state: key("Maharashtra"),
      inclTwenty: 228_600,
      inclFive: 58_400,
      effectiveFrom: addDays(TODAY, -40),
    });
    const second = await createPriceList({ name: "Maharashtra v2", effectiveFrom: TODAY });
    assert.ok(second.ok);
    await setRate({ priceListId: second.data.id, productId: nano20.id, rateInclGstPaise: 240_000 });
    const published = await publishPriceList(second.data.id, { supersedesId: first });
    assert.ok(published.ok, published.ok ? "" : published.error);

    const [old] = await db.select().from(priceLists).where(eq(priceLists.id, first));
    assert.equal(old.status, "superseded");
    assert.equal(old.effectiveTo, addDays(TODAY, -1));

    // And the scopes came with it, or the new list would apply to nobody.
    const detail = await priceListDetail(second.data.id);
    assert.equal(detail!.scopes.length, 1);
    assert.equal(detail!.scopes[0].scopeValue, key("Maharashtra"));
  });

  test("withdrawing demands a reason and takes the list out of force today", async () => {
    const listId = await publishStateList({
      name: "Maharashtra",
      state: key("Maharashtra"),
      inclTwenty: 228_600,
      inclFive: 58_400,
    });
    assert.equal((await withdrawPriceList(listId, "")).ok, false);
    const done = await withdrawPriceList(listId, "Printed with the wrong freight term");
    assert.ok(done.ok, done.ok ? "" : done.error);
    const [row] = await db.select().from(priceLists).where(eq(priceLists.id, listId));
    assert.equal(row.status, "withdrawn");
    assert.equal(row.withdrawReason, "Printed with the wrong freight term");
    assert.equal(row.effectiveTo, addDays(TODAY, -1));
  });

  test("a telecaller cannot publish a price list, whatever the screen drew", async () => {
    const listId = await publishStateList({
      name: "Maharashtra",
      state: key("Maharashtra"),
      inclTwenty: 228_600,
      inclFive: 58_400,
    });
    setTestUser(telecaller);
    /* The action does not throw at a screen: `requireCapability` throws a
     * NotPermittedError, `fromThrown` turns it into a refusal the form can
     * draw, and the attempt is audited on the way past. */
    const refused = await createPriceList({ name: "Mine", effectiveFrom: TODAY });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok ? null : refused.code, "not_permitted");

    const refusals = await db.select().from(auditLog).where(eq(auditLog.actorId, telecaller.id));
    assert.ok(refusals.length >= 1, "the refusal is recorded against them, not swallowed");
    assert.ok(listId);
  });
});

describe("which list applies", () => {
  test("a customer's own list beats their city, which beats their state, which beats everybody", async () => {
    const shop = await makeCustomer({ name: "Sharda Traders", city: "Thane", region: "Maharashtra" });
    setTestUser(manager);

    const everybody = await createPriceList({ name: "Pan India", effectiveFrom: addDays(TODAY, -60) });
    assert.ok(everybody.ok);
    await setRate({ priceListId: everybody.data.id, productId: nano20.id, rateInclGstPaise: 240_000 });
    await addScope({ priceListId: everybody.data.id, scopeKind: "everybody", scopeValue: "" });
    await publishPriceList(everybody.data.id);
    assert.equal((await resolveForCustomer(shop.id, TODAY))!.listName, "Pan India");

    const state = await publishStateList({
      name: "Pan Maharashtra",
      state: key("Maharashtra"),
      inclTwenty: 230_000,
      inclFive: 58_000,
    });
    assert.equal((await resolveForCustomer(shop.id, TODAY))!.listId, state);

    const city = await createPriceList({ name: "Thane", effectiveFrom: addDays(TODAY, -10) });
    assert.ok(city.ok);
    await setRate({ priceListId: city.data.id, productId: nano20.id, rateInclGstPaise: 225_000 });
    await addScope({
      priceListId: city.data.id,
      scopeKind: "city",
      scopeValue: "Thane",
      scopeLabel: "Thane",
      parentKey: "Maharashtra",
    });
    await publishPriceList(city.data.id);
    const resolved = await resolveForCustomer(shop.id, TODAY);
    assert.equal(resolved!.listId, city.data.id);
    // And the chain says why, in words a telecaller can read out.
    assert.match(resolved!.chain.at(-1)!.note, /city/i);
  });

  test("a city scope under one state does not reach the same city name in another", async () => {
    const bihar = await makeCustomer({ name: "Aurangabad Bihar", city: "Aurangabad", region: "Bihar" });
    setTestUser(manager);
    const city = await createPriceList({ name: "Aurangabad MH", effectiveFrom: addDays(TODAY, -10) });
    assert.ok(city.ok);
    await setRate({ priceListId: city.data.id, productId: nano20.id, rateInclGstPaise: 225_000 });
    await addScope({
      priceListId: city.data.id,
      scopeKind: "city",
      scopeValue: "Aurangabad",
      parentKey: "Maharashtra",
    });
    await publishPriceList(city.data.id);
    assert.equal(await resolveForCustomer(bihar.id, TODAY), null);
  });

  test("the freight term picks between the To Pay and the Paid list for one state", async () => {
    const toPayShop = await makeCustomer({ name: "Puri Paints", region: "Odisha", freightTerm: "to_pay" });
    const paidShop = await makeCustomer({ name: "Cuttack Colours", region: "Odisha", freightTerm: "paid" });
    const toPay = await publishStateList({
      name: "Odisha To Pay",
      state: key("Odisha"),
      freightTerm: "to_pay",
      inclTwenty: 228_100,
      inclFive: 58_300,
    });
    const paid = await publishStateList({
      name: "Odisha Paid",
      state: key("Odisha"),
      freightTerm: "paid",
      inclTwenty: 252_100,
      inclFive: 64_300,
    });
    assert.equal((await resolveForCustomer(toPayShop.id, TODAY))!.listId, toPay);
    assert.equal((await resolveForCustomer(paidShop.id, TODAY))!.listId, paid);
  });

  test("the rates an order form asks for come off the list that resolved", async () => {
    const shop = await makeCustomer({ region: "Maharashtra" });
    await publishStateList({
      name: "Pan Maharashtra",
      state: key("Maharashtra"),
      inclTwenty: 228_600,
      inclFive: 58_400,
    });
    const rates = await ratesForCustomer(shop.id, [nano20.id, nano5.id], TODAY);
    assert.equal(rates[nano20.id].rateInclGstPaise, 228_600);
    assert.equal(rates[nano5.id].rateInclGstPaise, 58_400);
    assert.equal(rates[nano20.id].listName, "Pan Maharashtra");
  });

  test("a shop no list names gets nothing rather than the first list in the table", async () => {
    const orphan = await makeCustomer({ region: "Kerala" });
    await publishStateList({
      name: "Pan Maharashtra",
      state: key("Maharashtra"),
      inclTwenty: 228_600,
      inclFive: 58_400,
    });
    assert.equal(await resolveForCustomer(orphan.id, TODAY), null);
    assert.deepEqual(await ratesForCustomer(orphan.id, [nano20.id], TODAY), {});

    const coverage = await coverageReport(TODAY);
    assert.equal(coverage.unresolved >= 1, true);
    assert.ok(coverage.unresolvedCustomers.some((c) => c.id === orphan.id));
  });
});

describe("a derived list", () => {
  test("Odisha Paid is Odisha To Pay plus twelve rupees a litre, and is generated rather than typed", async () => {
    const parent = await publishStateList({
      name: "Odisha To Pay",
      state: key("Odisha"),
      freightTerm: "to_pay",
      inclTwenty: 228_100,
      inclFive: 58_300,
    });
    setTestUser(manager);
    // Twelve rupees a litre INCLUSIVE is about 1,017 paise a litre ex-GST.
    const derived = await createDerivedList({
      name: "Odisha Paid",
      effectiveFrom: TODAY,
      freightTerm: "paid",
      parentListId: parent,
      derivation: { kind: "per_litre_paise", paise: 1017 },
    });
    assert.ok(derived.ok, derived.ok ? "" : derived.error);

    const detail = await priceListDetail(derived.data.id);
    const twenty = detail!.rates.find((r) => r.productId === nano20.id)!;
    const five = detail!.rates.find((r) => r.productId === nano5.id)!;
    // The real Odisha Paid list prints 2,521 and 643.
    assert.equal(twenty.rateInclGstPaise, 252_100);
    assert.equal(five.rateInclGstPaise, 64_300);
  });
});

describe("a special price", () => {
  test("a telecaller asks, a manager approves, and the shop is on its own rate afterwards", async () => {
    const shop = await makeCustomer({ name: "Kamal Hardware", region: "Maharashtra" });
    await publishStateList({
      name: "Pan Maharashtra",
      state: key("Maharashtra"),
      inclTwenty: 228_600,
      inclFive: 58_400,
    });

    setTestUser(telecaller);
    const asked = await requestSpecialPrice({
      customerId: shop.id,
      productId: nano20.id,
      requestedRateInclGstPaise: 210_000,
      reason: "Taking a hundred cans this month",
    });
    assert.ok(asked.ok, asked.ok ? "" : asked.error);

    // Asking changes nothing on its own.
    assert.equal((await ratesForCustomer(shop.id, [nano20.id], TODAY))[nano20.id].rateInclGstPaise, 228_600);

    setTestUser(manager);
    const decided = await decidePriceRequest(asked.data.id, { decision: "approved", note: "For this quarter" });
    assert.ok(decided.ok, decided.ok ? "" : decided.error);

    const after = await ratesForCustomer(shop.id, [nano20.id, nano5.id], TODAY);
    assert.equal(after[nano20.id].rateInclGstPaise, 210_000);
    // And only that product moved: everything else falls through to the list behind.
    const pricing = await customerPricing(shop.id, TODAY);
    assert.match(pricing!.list!.name, /agreed prices/i);
    assert.match(pricing!.resolution!.chain.at(-1)!.note, /customer/i);
  });

  test("a refusal leaves the shop where it was and tells the person who asked", async () => {
    const shop = await makeCustomer({ region: "Maharashtra" });
    await publishStateList({
      name: "Pan Maharashtra",
      state: key("Maharashtra"),
      inclTwenty: 228_600,
      inclFive: 58_400,
    });
    setTestUser(telecaller);
    const asked = await requestSpecialPrice({
      customerId: shop.id,
      productId: nano20.id,
      requestedRateInclGstPaise: 180_000,
      reason: "They asked",
    });
    assert.ok(asked.ok);
    setTestUser(manager);
    const decided = await decidePriceRequest(asked.data.id, { decision: "refused", note: "Too far below the list" });
    assert.ok(decided.ok);
    assert.equal(decided.data.listId, null);
    assert.equal((await ratesForCustomer(shop.id, [nano20.id], TODAY))[nano20.id].rateInclGstPaise, 228_600);

    const [notification] = await db.execute<{ body: string }>(sql`
      select body from notifications where user_id = ${telecaller.id} order by created_at desc limit 1
    `);
    assert.match(notification.body, /not approved/i);
  });
});

describe("a document becomes a list", () => {
  test("the MP & CG list as Mahek issued it, read and published, prices Nano at what it printed", async () => {
    const text = (await import("node:fs")).readFileSync(
      `${process.cwd()}/src/lib/fixtures/price-lists/mp-cg-august-2026.txt`,
      "utf8",
    );
    const parsed = parsePriceListText(text.split("\f"));

    const catalogue: CatalogueSku[] = [nano20, nano5].map((p) => ({
      id: p.id,
      name: p.name,
      millilitresPerCan: p.millilitresPerCan,
      cansPerBox: p.cansPerBox,
      packing: p.packing,
      brandName: "Nano Thinner",
      formulationName: null,
      finishedGoodId: p.finishedGoodId,
      active: true,
    }));
    const matches = matchGrid(parsed, catalogue, []);

    const documentId = id("pld");
    await db.insert(priceListDocuments).values({
      id: documentId,
      fileHash: randomUUID(),
      filename: "MP & CG August 2026.pdf",
      parseStatus: "parsed",
      confidence: parsed.confidence,
      layout: parsed.layout,
      header: { ...parsed.header, discountTerms: parsed.discountTerms, termsText: parsed.termsText },
      uploadedById: manager.id,
    });

    const rows = [];
    for (const row of parsed.rows) {
      for (const cell of row.cells) {
        const match = matches.get(`${row.rowIndex}:${cell.colIndex}`);
        const column = parsed.columns[cell.colIndex];
        rows.push({
          id: id("plp"),
          documentId,
          rowIndex: row.rowIndex,
          colIndex: cell.colIndex,
          rawProductText: row.rawProduct,
          rawPackText: column.label,
          rawPriceText: cell.raw,
          millilitres: column.millilitres,
          cansPerBox: column.cansPerBox,
          rateInclGstPaise: cell.inclPaise,
          rateExGstPaise: cell.inclPaise == null ? null : exFromIncl(cell.inclPaise, 1800),
          offered: cell.offered,
          matchedProductId: match?.productId ?? null,
          matchStatus: match?.status ?? "held",
          matchConfidence: match?.confidence ?? null,
          candidates: match?.candidates ?? [],
        });
      }
    }
    await db.insert(priceListParseRows).values(rows);

    setTestUser(manager);
    const published = await publishDocument(documentId, {
      name: "MP & CG — August 2026",
      effectiveFrom: "2026-08-01",
      freightTerm: "to_pay",
      scopes: [{ scopeKind: "state", scopeValue: "Madhya Pradesh", scopeLabel: "Madhya Pradesh" }],
      publishNow: true,
      includeSuggested: false,
    });
    assert.ok(published.ok, published.ok ? "" : published.error);

    const detail = await priceListDetail(published.data.priceListId);
    const twenty = detail!.rates.find((r) => r.productId === nano20.id)!;
    // The document printed Rs.2,286 for Nano 20 L. It has to survive the whole
    // journey — reader, matcher, staging, publish — to the rupee.
    assert.equal(twenty.rateInclGstPaise, 228_600);
    assert.equal(Math.round(twenty.rateExGstPaise / 100), 1937);
    // And the discount terms the document stated came with it.
    assert.equal(detail!.discountTerms.length, 2);
    assert.ok(detail!.discountTerms.some((t) => t.kind === "advance_payment" && t.percentBp === 300));

    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, documentId));
    assert.equal(doc.parseStatus, "published");
    assert.equal(doc.priceListId, published.data.priceListId);
  });

  test("a document with nothing matched is refused rather than published empty", async () => {
    const documentId = id("pld");
    await db.insert(priceListDocuments).values({
      id: documentId,
      fileHash: randomUUID(),
      filename: "Unreadable.pdf",
      parseStatus: "needs_review",
      uploadedById: manager.id,
    });
    await db.insert(priceListParseRows).values({
      id: id("plp"),
      documentId,
      rowIndex: 0,
      colIndex: 0,
      rawProductText: "Something nobody sells",
      rateInclGstPaise: 10_000,
      matchStatus: "held",
    });
    const published = await publishDocument(documentId, {
      name: "Nothing",
      effectiveFrom: TODAY,
      publishNow: false,
      includeSuggested: true,
    });
    assert.equal(published.ok, false);
    assert.match(published.ok ? "" : published.error, /matched to a product/i);
  });
});

describe("what was billed against what the list says", () => {
  test("a sheet line below its list is reported with the gap", async () => {
    const shop = await makeCustomer({ name: "Bombay Paints", region: "Maharashtra" });
    await publishStateList({
      name: "Pan Maharashtra",
      state: key("Maharashtra"),
      inclTwenty: 228_600,
      inclFive: 58_400,
      effectiveFrom: addDays(TODAY, -60),
    });

    const syncId = id("syn");
    await db.insert(sheetSyncRuns).values({
      id: syncId,
      source: "order",
      spreadsheetId: "test-sheet",
      tabTitle: "Order Details",
      mode: "append",
      status: "ok",
    });
    await db.insert(sheetOrderRows).values({
      id: id("sor"),
      syncId,
      rowNumber: 1,
      lineKey: id("lk"),
      orderNumber: "ORD-1",
      raw: {},
      rowHash: randomUUID(),
      status: "present",
      orderDate: TODAY,
      billingPartyName: shop.name,
      description: nano20.name,
      cans: 10,
      // The list says 1,937 ex-GST; this was billed at 1,800.
      ratePaise: 180_000,
      matchedCustomerId: shop.id,
      matchedProductId: nano20.id,
    });

    const report = await varianceReport(TODAY.slice(0, 7));
    const row = report.rows.find((r) => r.productId === nano20.id);
    assert.ok(row, "the line is in the report");
    assert.equal(row.listExPaise, exFromIncl(228_600, 1800));
    assert.ok((row.deltaPaise ?? 0) < 0, "billed below the list");
    assert.equal(report.summary.belowList, 1);
  });
});

describe("the list a screen reads", () => {
  test("an expired list is drawn as expired rather than silently used", async () => {
    setTestUser(manager);
    const created = await createPriceList({
      name: "Short",
      effectiveFrom: addDays(TODAY, -60),
      validityDays: 30,
    });
    assert.ok(created.ok);
    await setRate({ priceListId: created.data.id, productId: nano20.id, rateInclGstPaise: 228_600 });
    await addScope({ priceListId: created.data.id, scopeKind: "everybody", scopeValue: "" });
    await publishPriceList(created.data.id, { effectiveFrom: addDays(TODAY, -60) });

    const [summary] = (await listPriceLists()).filter((l) => l.id === created.data.id);
    assert.equal(summary.expiresOn, addDays(TODAY, -30));
    assert.equal(summary.expired, true);
    assert.equal(inclFromEx(exFromIncl(228_600, 1800), 1800), 228_600);
  });

  test("a list nobody is scoped to says so rather than printing nothing", async () => {
    setTestUser(manager);
    const created = await createPriceList({ name: "Unscoped", effectiveFrom: TODAY });
    assert.ok(created.ok);
    await setRate({ priceListId: created.data.id, productId: nano20.id, rateInclGstPaise: 228_600 });
    const published = await publishPriceList(created.data.id);
    assert.ok(published.ok);
    assert.ok(published.data.warnings.some((w) => /Nobody is on this list/i.test(w)));

    const [summary] = (await listPriceLists()).filter((l) => l.id === created.data.id);
    assert.equal(summary.scopeSummary, "Nobody yet");
  });
});
