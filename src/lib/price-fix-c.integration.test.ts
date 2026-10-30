/**
 * THE PRICE-LIST EDITOR AND THE IMPORT, AGAINST A DATABASE.
 *
 * `engines/price-fix-c.test.ts` pins the pure rules. What only a database can
 * show: a version keeps its scopes' priority and dates, a save keeps the
 * quantity slabs the grid does not draw, the desk is asked and not only the
 * capability, a ₹0 cell cannot go into force, one document becomes one list
 * however many times it is published at once, a read is claimed so a second
 * read is refused, a stalled read is swept to failed, a corrected header
 * re-states every staged figure, and a GST-extra correction is grossed up.
 *
 * Needs mahekone_test (`npm run test:db`). Truncates its own tables.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  finishedGoods,
  priceListDocuments,
  priceListParseRows,
  priceListRates,
  priceListScopes,
  priceLists,
  productBrands,
  productFormulations,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { exFromIncl, inclFromEx } from "@/lib/engines/price-math";
import { STALE_READ_MS } from "@/lib/engines/price-document";
import { columnOf, familiesOf, skuFor, type PriceSheet, type SheetProduct } from "@/lib/price-sheet";
import { duplicatePriceList, savePriceSheet } from "@/lib/actions/price-sheets";
import { publishDocument, reparseDocument, setParseRowPrice, updateDocumentHeader } from "@/lib/actions/price-lists";
import { failStaleReads, parseDocument } from "@/lib/services/price-list-parse-service";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let TODAY: string;
let desk: typeof users.$inferSelect;
let catalogue: SheetProduct[];

async function makeUser(name: string, grants: Array<{ app: "sales" | "accounts" | "founder" | "crm"; role: "associate" | "manager" }>) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role: grants.some((g) => g.role === "manager") ? "manager" : "associate",
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  for (const g of grants) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: g.app, role: g.role });
  return row;
}

async function makeProduct(brand: string, name: string, millilitres: number, cansPerBox: number, packing: string) {
  const [f] = await db.select().from(productFormulations).where(eq(productFormulations.name, `F ${brand}`));
  const formulationId = f?.id ?? id("fml");
  if (!f) await db.insert(productFormulations).values({ id: formulationId, name: `F ${brand}`, slug: id("s") });
  const [b] = await db.select().from(productBrands).where(eq(productBrands.name, brand));
  const brandId = b?.id ?? id("brn");
  if (!b) await db.insert(productBrands).values({ id: brandId, name: brand, slug: id("s"), formulationId });
  const fgId = id("fgd");
  await db.insert(finishedGoods).values({ id: fgId, name: name.split(" (")[0], slug: id("s"), brandId, formulationId, millilitres });
  const [row] = await db
    .insert(products)
    .values({ id: id("prd"), name, millilitresPerCan: millilitres, cansPerBox, packing, finishedGoodId: fgId, brandId, formulationId })
    .returning();
  return row;
}

function sheetOf(prices: Record<string, number>, over: Partial<PriceSheet> = {}): PriceSheet {
  const families = familiesOf(catalogue);
  const columns = [...new Map(catalogue.map((p) => [columnOf(p).key, columnOf(p)])).values()].sort((a, b) => (a.millilitres ?? 0) - (b.millilitres ?? 0));
  return {
    name: "Odisha To Pay — October 2026",
    refNo: "PL0200",
    effectiveFrom: TODAY,
    validityDays: 30,
    taxBasis: "inclusive",
    gstBp: 1800,
    deliveryBasis: "for_godown",
    freightTerm: "to_pay",
    columns,
    rows: families.map((f) => ({
      key: f.key,
      label: f.name,
      familyKey: f.key,
      cells: Object.fromEntries(
        columns.map((c) => {
          const sku = skuFor(f, c);
          return [c.key, { productId: sku?.id ?? null, printedPaise: sku ? (prices[sku.name] ?? null) : null, offered: !!sku }];
        }),
      ),
    })),
    terms: ["All prices are inclusive of GST @ 18%."],
    discounts: [],
    signatory: "Heena Doshi",
    signatoryTitle: null,
    ...over,
  };
}

const PRICES = {
  "Nano Thinner - 1 Liter (32 Can/Box)": 13_500,
  "Nano Thinner - 20 Liter (2 Can/Box)": 252_100,
};

const nano20 = () => catalogue.find((p) => p.name.startsWith("Nano Thinner - 20"))!;
const nano1 = () => catalogue.find((p) => p.name.startsWith("Nano Thinner - 1 "))!;

async function stagedDocument(cells: Array<Partial<typeof priceListParseRows.$inferInsert>>, header: Record<string, unknown> = { taxBasis: "inclusive", gstBp: 1800 }) {
  const documentId = id("pld");
  await db.insert(priceListDocuments).values({
    id: documentId,
    fileHash: randomUUID(),
    filename: "Odisha.pdf",
    parseStatus: "parsed",
    header: header as never,
    uploadedById: desk.id,
  });
  // A document with no staged cells is a real state (a read that has not got
  // that far); Drizzle refuses an empty insert, so skip it rather than fail.
  if (!cells.length) return documentId;
  await db.insert(priceListParseRows).values(
    cells.map((c, i) => ({
      id: id("plp"),
      documentId,
      rowIndex: i,
      colIndex: 0,
      rawProductText: "Maruti Nano Thinner",
      offered: true,
      matchStatus: "matched" as const,
      ...c,
    })),
  );
  return documentId;
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
      price_list_documents, audit_log, notifications, attachments,
      app_module_access, app_access, sessions, users,
      products, finished_goods, product_brands, product_formulations,
      app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  desk = await makeUser("Deepa", [{ app: "accounts", role: "associate" }]);
  await makeProduct("Maruti Nano Thinner", "Nano Thinner - 1 Liter (32 Can/Box)", 1000, 32, "32 Can/Box");
  await makeProduct("Maruti Nano Thinner", "Nano Thinner - 20 Liter (2 Can/Box)", 20000, 2, "2 Can/Box");
  const rows = await db.execute<SheetProduct>(sql`
    select p.id, p.name, p.millilitres_per_can as "millilitresPerCan", p.cans_per_box as "cansPerBox",
           p.packing, b.name as "brandName", f.name as "formulationName", p.active
      from products p left join product_brands b on b.id = p.brand_id left join product_formulations f on f.id = p.formulation_id
  `);
  catalogue = [...rows];
  setTestUser(desk);
});

/* ------------------------------------------------------------- the editor */

describe("saving from the editor", () => {
  test("B10: a new version keeps its inherited scopes' priority and dates", async () => {
    const first = await savePriceSheet({ mode: "create", sheet: sheetOf(PRICES), scopes: [{ kind: "everybody" }] });
    assert.ok(first.ok, first.ok ? "" : first.error);
    await db
      .update(priceListScopes)
      .set({ priority: 7, validFrom: TODAY, validTo: "2099-12-31" })
      .where(eq(priceListScopes.priceListId, first.data.listId));
    await db.update(priceLists).set({ status: "published" }).where(eq(priceLists.id, first.data.listId));

    const inherited = await savePriceSheet({ mode: "version", listId: first.data.listId, sheet: sheetOf(PRICES), scopes: null });
    assert.ok(inherited.ok, inherited.ok ? "" : inherited.error);
    const [s] = await db.select().from(priceListScopes).where(eq(priceListScopes.priceListId, inherited.data.listId));
    assert.equal(s.priority, 7);
    assert.equal(s.validTo, "2099-12-31");

    // And the editor's own scopes, sent back as loaded, keep them too.
    const sent = await savePriceSheet({
      mode: "version",
      listId: first.data.listId,
      sheet: sheetOf(PRICES),
      scopes: [{ kind: "everybody", priority: 7, validFrom: TODAY, validTo: "2099-12-31" }],
    });
    assert.ok(sent.ok);
    const [t] = await db.select().from(priceListScopes).where(eq(priceListScopes.priceListId, sent.data.listId));
    assert.equal(t.priority, 7);
    assert.equal(t.validFrom, TODAY);
  });

  test("B11: saving a draft keeps the quantity slabs, and a version carries them across", async () => {
    const first = await savePriceSheet({ mode: "create", sheet: sheetOf(PRICES) });
    assert.ok(first.ok);
    await db.insert(priceListRates).values({
      id: id("plr"),
      priceListId: first.data.listId,
      productId: nano20().id,
      rateExGstPaise: 200_000,
      rateInclGstPaise: inclFromEx(200_000, 1800),
      minCans: 50,
      maxCans: null,
    });
    const again = await savePriceSheet({ mode: "update", listId: first.data.listId, sheet: sheetOf({ ...PRICES, "Nano Thinner - 20 Liter (2 Can/Box)": 260_000 }) });
    assert.ok(again.ok, again.ok ? "" : again.error);
    const rates = await db.select().from(priceListRates).where(eq(priceListRates.priceListId, first.data.listId));
    const slab = rates.find((r) => r.minCans === 50);
    assert.ok(slab, "the 50-can slab survived the save");
    assert.equal(Number(slab!.rateExGstPaise), 200_000);
    assert.equal(Number(rates.find((r) => r.productId === nano20().id && r.minCans == null)!.rateInclGstPaise), 260_000);

    await db.update(priceLists).set({ status: "published" }).where(eq(priceLists.id, first.data.listId));
    const version = await savePriceSheet({ mode: "version", listId: first.data.listId, sheet: sheetOf(PRICES) });
    assert.ok(version.ok);
    const carried = await db.select().from(priceListRates).where(eq(priceListRates.priceListId, version.data.listId));
    assert.ok(carried.some((r) => r.minCans === 50 && r.productId === nano20().id));
  });

  test("B13: somebody narrowed off the Price lists desk cannot save or duplicate by posting to the action", async () => {
    const src = await savePriceSheet({ mode: "create", sheet: sheetOf(PRICES) });
    assert.ok(src.ok);
    await db.insert(appModuleAccess).values({ id: id("ama"), userId: desk.id, app: "accounts", module: "accounts.today" });
    const saved = await savePriceSheet({ mode: "create", sheet: sheetOf(PRICES) });
    assert.equal(saved.ok ? null : saved.code, "not_permitted");
    const copy = await duplicatePriceList(src.data.listId, { name: "x", effectiveFrom: TODAY, copyScopes: false });
    assert.equal(copy.ok ? null : copy.code, "not_permitted");
  });

  test("B14: a ₹0 cell can be saved as a draft and cannot go into force", async () => {
    const zero = { ...PRICES, "Nano Thinner - 1 Liter (32 Can/Box)": 0 };
    const draft = await savePriceSheet({ mode: "create", sheet: sheetOf(zero) });
    assert.ok(draft.ok, "a draft is a place to leave unfinished work");
    const live = await savePriceSheet({ mode: "create", sheet: sheetOf(zero), scopes: [{ kind: "everybody" }], publish: {} });
    assert.equal(live.ok, false);
    assert.match(live.ok ? "" : live.error, /zero/);
  });
});

/* ------------------------------------------------------------- the import */

describe("a document becomes one list", () => {
  test("B16: two publishes at once make one list, and the second is refused", async () => {
    const documentId = await stagedDocument([{ matchedProductId: nano20().id, rateInclGstPaise: 252_100, rateExGstPaise: exFromIncl(252_100, 1800) }]);
    const input = { name: "Odisha", effectiveFrom: TODAY, publishNow: false, includeSuggested: false };
    const [a, b] = await Promise.all([publishDocument(documentId, input), publishDocument(documentId, input)]);
    assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
    assert.equal((await db.select().from(priceLists)).length, 1);
  });

  test("B24 + B31: a blank and a suggestion never push out the real price; two prices for one SKU hold the document", async () => {
    const clean = await stagedDocument([
      { matchedProductId: nano20().id, rateInclGstPaise: null, rateExGstPaise: null },
      { matchedProductId: nano20().id, matchStatus: "suggested", rateInclGstPaise: 999_900, rateExGstPaise: exFromIncl(999_900, 1800) },
      { matchedProductId: nano20().id, rateInclGstPaise: 228_094, rateExGstPaise: exFromIncl(228_094, 1800) },
    ]);
    const r = await publishDocument(clean, { name: "One", effectiveFrom: TODAY, publishNow: false, includeSuggested: true });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const [rate] = await db.select().from(priceListRates).where(eq(priceListRates.priceListId, r.data.priceListId));
    assert.equal(Number(rate.rateInclGstPaise), 228_094, "the printed inclusive figure, to the paisa");

    const clash = await stagedDocument([
      { matchedProductId: nano1().id, rateInclGstPaise: 13_500, rateExGstPaise: exFromIncl(13_500, 1800) },
      { matchedProductId: nano1().id, matchStatus: "manual", rateInclGstPaise: 14_700, rateExGstPaise: exFromIncl(14_700, 1800) },
    ]);
    const held = await publishDocument(clash, { name: "Two", effectiveFrom: TODAY, publishNow: false, includeSuggested: false });
    assert.equal(held.ok, false);
    assert.match(held.ok ? "" : held.error, /Nano Thinner - 1 Liter/);
  });

  test("B32: correcting the tax basis re-states every staged figure from what was printed", async () => {
    const documentId = await stagedDocument([{ matchedProductId: nano20().id, rateInclGstPaise: 200_000, rateExGstPaise: exFromIncl(200_000, 1800) }]);
    const r = await updateDocumentHeader(documentId, { taxBasis: "exclusive" });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const [row] = await db.select().from(priceListParseRows).where(eq(priceListParseRows.documentId, documentId));
    assert.equal(row.rateExGstPaise, 200_000);
    assert.equal(row.rateInclGstPaise, 236_000);
    const pub = await publishDocument(documentId, { name: "Extra", effectiveFrom: TODAY, publishNow: false, includeSuggested: false });
    assert.ok(pub.ok);
    const [rate] = await db.select().from(priceListRates).where(eq(priceListRates.priceListId, pub.data.priceListId));
    assert.equal(Number(rate.rateExGstPaise), 200_000);
  });

  test("B40: a corrected price on a GST-extra document is the ex figure, grossed up beside it", async () => {
    const documentId = await stagedDocument([{ matchedProductId: nano20().id, rateInclGstPaise: null, rateExGstPaise: null }], { taxBasis: "exclusive", gstBp: 1800 });
    const [row] = await db.select().from(priceListParseRows).where(eq(priceListParseRows.documentId, documentId));
    const r = await setParseRowPrice({ rowId: row.id, printedPaise: 100_000, offered: true });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const [fixed] = await db.select().from(priceListParseRows).where(eq(priceListParseRows.id, row.id));
    assert.equal(fixed.rateExGstPaise, 100_000);
    assert.equal(fixed.rateInclGstPaise, 118_000);
  });
});

describe("one read at a time", () => {
  test("B33: a published document is never read again, by the route's service or by the action", async () => {
    const documentId = await stagedDocument([{ matchedProductId: nano20().id, rateInclGstPaise: 252_100, rateExGstPaise: exFromIncl(252_100, 1800) }]);
    await db.update(priceListDocuments).set({ parseStatus: "published" }).where(eq(priceListDocuments.id, documentId));
    const read = await parseDocument(documentId);
    assert.equal(read.refused, "final");
    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, documentId));
    assert.equal(doc.parseStatus, "published");
    assert.equal((await reparseDocument(documentId)).ok, false);
  });

  test("B36: a document a live read holds is refused a second read; a dead one may be taken over", async () => {
    const documentId = await stagedDocument([]);
    await db.update(priceListDocuments).set({ parseStatus: "matching", stageStartedAt: new Date() }).where(eq(priceListDocuments.id, documentId));
    assert.equal((await parseDocument(documentId)).refused, "running");
    assert.equal((await reparseDocument(documentId)).ok, false);

    await db
      .update(priceListDocuments)
      .set({ stageStartedAt: new Date(Date.now() - STALE_READ_MS - 60_000) })
      .where(eq(priceListDocuments.id, documentId));
    const taken = await parseDocument(documentId);
    assert.equal(taken.refused, undefined, "a stalled read is taken over, not refused");
  });

  test("B37: the hourly sweep fails a read that stalled, and leaves a live one alone", async () => {
    const dead = await stagedDocument([]);
    const live = await stagedDocument([]);
    await db
      .update(priceListDocuments)
      .set({ parseStatus: "extracting", stageStartedAt: new Date(Date.now() - STALE_READ_MS - 60_000) })
      .where(eq(priceListDocuments.id, dead));
    await db.update(priceListDocuments).set({ parseStatus: "extracting", stageStartedAt: new Date() }).where(eq(priceListDocuments.id, live));
    assert.equal(await failStaleReads(), 1);
    const [d] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, dead));
    const [l] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, live));
    assert.equal(d.parseStatus, "failed");
    assert.match(d.stageNote ?? "", /Read it again/);
    assert.equal(l.parseStatus, "extracting");
  });
});
