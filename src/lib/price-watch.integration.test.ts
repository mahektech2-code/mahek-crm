/**
 * WATCH THE MONEY — order lines from the sheet and the ERP judged against the
 * revision of the book live on each line's own date, against the real
 * database and the real actions.
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
  auditLog,
  customers,
  erpGodowns,
  erpOrders,
  finishedGoods,
  notifications,
  priceListRates,
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
import { addScope, createPriceList, newVersion, publishPriceList, setRate } from "@/lib/actions/price-lists";
import { varianceReport, varianceRowsForRange } from "@/lib/services/price-list-service";
import { watchReport } from "@/lib/services/price-watch-service";
import { askAboutLine, sendToFounder, summariseWatch } from "@/lib/actions/price-watch";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

let TODAY: string;
let desk: typeof users.$inferSelect;
let founder: typeof users.$inferSelect;
let telecaller: typeof users.$inferSelect;
let erpUser: typeof users.$inferSelect;
let nano20: typeof products.$inferSelect;
let other: typeof products.$inferSelect;
let shop: typeof customers.$inferSelect;
let syncId: string;
let godownId: string;
let v1Ex: number;
let v2Ex: number;

async function makeUser(name: string, role: "associate" | "manager", apps: Array<"crm" | "accounts" | "founder">) {
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

async function exRate(listId: string, productId: string): Promise<number> {
  const [r] = await db.select().from(priceListRates).where(sql`${priceListRates.priceListId} = ${listId} and ${priceListRates.productId} = ${productId}`);
  return Number(r.rateExGstPaise);
}

/** v1 live since 40 days ago; v2 (dearer) from 10 days ago. */
async function bookWithRevision() {
  setTestUser(desk);
  const created = await createPriceList({ name: "Maharashtra", effectiveFrom: addDays(TODAY, -40), freightTerm: "not_stated", deliveryBasis: "for_mumbai" });
  assert.ok(created.ok, created.ok ? "" : created.error);
  assert.ok((await setRate({ priceListId: created.data.id, productId: nano20.id, rateInclGstPaise: 228_600 })).ok);
  assert.ok((await addScope({ priceListId: created.data.id, scopeKind: "state", scopeValue: key("Maharashtra"), scopeLabel: "Maharashtra" })).ok);
  const p1 = await publishPriceList(created.data.id);
  assert.ok(p1.ok, p1.ok ? "" : p1.error);
  v1Ex = await exRate(created.data.id, nano20.id);

  const v2 = await newVersion(created.data.id, { effectiveFrom: addDays(TODAY, -10) });
  assert.ok(v2.ok, v2.ok ? "" : v2.error);
  assert.ok((await setRate({ priceListId: v2.data.id, productId: nano20.id, rateInclGstPaise: 240_000 })).ok);
  const p2 = await publishPriceList(v2.data.id);
  assert.ok(p2.ok, p2.ok ? "" : p2.error);
  v2Ex = await exRate(v2.data.id, nano20.id);
  assert.ok(v2Ex > v1Ex);
}

let row = 0;
async function sheetLine(input: { date: string; productId: string | null; rate: number; cans: number; salesMan?: string | null }) {
  const lid = id("sor");
  await db.insert(sheetOrderRows).values({
    id: lid,
    syncId,
    rowNumber: ++row,
    lineKey: id("ODID"),
    orderNumber: `S${row}`,
    raw: {},
    rowHash: id("h"),
    orderDate: input.date,
    billingPartyName: shop.name,
    salesMan: input.salesMan ?? null,
    description: "Nano 20",
    cans: input.cans,
    ratePaise: input.rate,
    matchedCustomerId: shop.id,
    matchedProductId: input.productId,
  });
  return lid;
}

let orderNo = 100;
async function erpLine(input: { date: string; rate: number; cans: number; rateSetById?: string | null; discountAuthorisedById?: string | null }) {
  const lid = id("eor");
  await db.insert(erpOrders).values({
    id: lid,
    orderNo: ++orderNo,
    orderDate: input.date,
    godownId,
    billingCustomerId: shop.id,
    deliveryCustomerId: shop.id,
    skuId: nano20.id,
    qtyCans: input.cans,
    ratePaise: input.rate,
    createdById: erpUser.id,
    rateSetById: input.rateSetById ?? null,
    discountAuthorisedById: input.discountAuthorisedById ?? null,
  });
  return lid;
}

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/);
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
      interaction_product_lines, sheet_order_rows, sheet_sync_runs, erp_orders, erp_godowns,
      app_access, sessions, customers, users,
      products, finished_goods, product_brands, product_formulations,
      app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  desk = await makeUser("Deepa", "manager", ["accounts"]);
  founder = await makeUser("Mahek", "manager", ["founder"]);
  telecaller = await makeUser("Priya", "associate", ["crm"]);
  erpUser = await makeUser("Asha", "associate", ["accounts"]);
  nano20 = await makeProduct("Nano Thinner - 20 Liter (2 Can/Box)", 20000, 2);
  other = await makeProduct("PU Thinner - 5 Liter (6 Can/Box)", 5000, 6);
  [shop] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: "Sai Paint Depot",
      contactPerson: "Contact",
      phone: testPhone(),
      city: "Thane",
      region: "Maharashtra",
      kind: "customer",
      ownerId: telecaller.id,
      salesAmId: telecaller.id,
    })
    .returning();
  [{ id: syncId }] = await db.insert(sheetSyncRuns).values({ id: id("ssr"), source: "orders", spreadsheetId: "x", tabTitle: "Order Details" }).returning();
  [{ id: godownId }] = await db.insert(erpGodowns).values({ id: id("gdn"), name: "Bhiwandi" }).returning();
  setTestUser(desk);
});

describe("each line is judged against the revision live on its own date", () => {
  test("below, at and above, across a revision boundary, with the money and who took it", async () => {
    await bookWithRevision();
    const before = addDays(TODAY, -20);
    const afterRev = addDays(TODAY, -5);
    const s1 = await sheetLine({ date: before, productId: nano20.id, rate: v1Ex - 1_000, cans: 4, salesMan: "Ramesh" }); // below v1
    const s2 = await sheetLine({ date: afterRev, productId: nano20.id, rate: v1Ex, cans: 2, salesMan: "Ramesh" }); // at v1, below v2
    const e1 = await erpLine({ date: afterRev, rate: v2Ex, cans: 3 }); // on v2
    const e2 = await erpLine({ date: addDays(TODAY, -15), rate: v1Ex + 500, cans: 1 }); // above v1
    const e3 = await erpLine({ date: afterRev, rate: v2Ex - 2_000, cans: 5, rateSetById: erpUser.id, discountAuthorisedById: desk.id }); // below v2, authorised
    const s3 = await sheetLine({ date: afterRev, productId: other.id, rate: 9_999, cans: 1 }); // no book price

    const lines = await varianceRowsForRange(addDays(TODAY, -30), addDays(TODAY, 1));
    const by = new Map(lines.map((l) => [l.lineId, l]));
    assert.equal(by.get(s1)!.listExPaise, v1Ex, "before the revision: v1");
    assert.equal(by.get(s2)!.listExPaise, v2Ex, "after the revision: v2");
    assert.equal(by.get(e1)!.deltaPaise, 0);
    assert.equal(by.get(e2)!.listExPaise, v1Ex);
    assert.equal(by.get(s3)!.listExPaise, null);
    assert.equal(by.get(s1)!.source, "sheet");
    assert.equal(by.get(s1)!.takenByName, "Ramesh");
    assert.equal(by.get(e3)!.source, "erp");
    assert.equal(by.get(e3)!.rateSetByName, "Asha");
    assert.equal(by.get(e3)!.discountAuthorisedById, desk.id);

    const report = await watchReport({ from: addDays(TODAY, -30), to: TODAY });
    const t = report.totals;
    assert.equal(t.lines, 6);
    assert.equal(t.priced, 5);
    assert.equal(t.below, 3);
    assert.equal(t.on, 1);
    assert.equal(t.above, 1);
    assert.equal(t.unpriced, 1);
    const expected = 1_000 * 4 + (v2Ex - v1Ex) * 2 + 2_000 * 5;
    assert.equal(t.givenAwayPaise, expected);
    assert.equal(t.unapprovedPaise, expected - 2_000 * 5, "the ERP-authorised discount is approved");

    assert.equal(report.byShopProduct.length, 1);
    const g = report.byShopProduct[0];
    assert.equal(g.lines, 3);
    assert.equal(g.cans, 11);
    assert.equal(g.listExPaise, v2Ex, "the newest line's book price");
    assert.equal(g.listPrices.length, 2);
    const ramesh = report.byPerson.find((p) => p.name === "Ramesh")!;
    assert.equal(ramesh.givenAwayPaise, 1_000 * 4 + (v2Ex - v1Ex) * 2);
    const asha = report.byPerson.find((p) => p.name === "Asha")!;
    assert.equal(asha.belowLines, 1, "the ERP's rate setter is who took it");

    // The window is inclusive at both ends: a range ending before the revision sees only s1 and e2.
    const early = await watchReport({ from: before, to: addDays(TODAY, -15) });
    assert.equal(early.totals.lines, 2);
  });

  test("the month variance report is unchanged: its fields, its order and its summary", async () => {
    await bookWithRevision();
    const day = addDays(TODAY, -5);
    const month = day.slice(0, 7);
    await sheetLine({ date: day, productId: nano20.id, rate: v2Ex - 1_000, cans: 3 });
    await erpLine({ date: day, rate: v2Ex + 2_000, cans: 1 });
    await sheetLine({ date: day, productId: nano20.id, rate: v2Ex, cans: 2 });
    await sheetLine({ date: day, productId: other.id, rate: 5_000, cans: 1 });

    const r = await varianceReport(month);
    assert.equal(r.month, month);
    assert.deepEqual(Object.keys(r.rows[0]).sort(), [
      "billedExPaise",
      "cans",
      "customerId",
      "customerName",
      "deltaBp",
      "deltaPaise",
      "listExPaise",
      "listId",
      "listName",
      "orderDate",
      "orderNumber",
      "productId",
      "productName",
      "sheetDiscountBp",
    ]);
    assert.deepEqual(r.summary, { lines: 4, onList: 1, belowList: 1, aboveList: 1, unresolved: 1, totalBelowPaise: 3_000 });
    assert.deepEqual(
      r.rows.map((x) => x.deltaPaise),
      [-1_000, 0, 2_000, null],
      "sorted by delta, most below first, unpriced last",
    );
  });
});

describe("the actions", () => {
  test("ask why tells the shop's account manager and the taker; a telecaller cannot", async () => {
    await bookWithRevision();
    const day = addDays(TODAY, -5);
    const lineId = await erpLine({ date: day, rate: v2Ex - 1_000, cans: 2, rateSetById: erpUser.id });

    setTestUser(telecaller);
    const refused = await askAboutLine({ lineId, orderDate: day });
    assert.equal(refused.ok, false);

    setTestUser(desk);
    const r = await askAboutLine({ lineId, orderDate: day });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(r.data.told, 2);
    const told = await db.select().from(notifications);
    assert.deepEqual(told.map((n) => n.userId).sort(), [telecaller.id, erpUser.id].sort());
    assert.match(told[0].body, /Sai Paint Depot was billed .* against .* on the book/);
    assert.equal(told[0].href, `/crm/customers/${shop.id}`);
    const [a] = await db.select().from(auditLog).where(eq(auditLog.action, "pricelist.watch.ask"));
    assert.equal(a.entityId, lineId);
  });

  test("send to founder tells whoever holds the Founder Dashboard", async () => {
    await bookWithRevision();
    await sheetLine({ date: addDays(TODAY, -5), productId: nano20.id, rate: v2Ex - 1_000, cans: 2 });
    const report = await watchReport({ from: addDays(TODAY, -7), to: TODAY });
    const r = await sendToFounder({ from: addDays(TODAY, -7), to: TODAY, groupKey: report.byShopProduct[0].key });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const told = await db.select().from(notifications);
    assert.deepEqual(told.map((n) => n.userId), [founder.id]);
    assert.ok(told[0].href?.startsWith("/founder/price-lists/watch"));

    setTestUser(telecaller);
    assert.equal((await sendToFounder({ from: addDays(TODAY, -7), to: TODAY })).ok, false);
  });

  test("the summary answers in words whatever the model does", async () => {
    await bookWithRevision();
    await sheetLine({ date: addDays(TODAY, -5), productId: nano20.id, rate: v2Ex - 1_000, cans: 2 });
    setTestUser(telecaller);
    const r = await summariseWatch({ from: addDays(TODAY, -7), to: TODAY });
    assert.ok(r.ok, r.ok ? "" : r.error);
    if (!r.data.ok) assert.ok(r.data.reason.length > 0);
  });
});
