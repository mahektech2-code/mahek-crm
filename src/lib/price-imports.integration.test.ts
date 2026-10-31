/**
 * A PDF YOU ALREADY HAVE, AS A CHANGE ON ITS BOOK — against the real database
 * and the real actions: the match ranks the right book first, the change
 * carries the document's prices and consumes the document, cancelling hands
 * the document back, an open change refuses, the old publish still makes a
 * new list, and the three readers are compared from stored runs.
 *
 *   npm run test:integration   (needs a migrated test database)
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  finishedGoods,
  priceAiRuns,
  priceChangeEvents,
  priceChanges,
  priceListDocuments,
  priceListParseRows,
  priceListRates,
  priceLists,
  productBrands,
  productFormulations,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { addDays } from "@/lib/business-date";
import { exFromIncl } from "@/lib/engines/price-math";
import { addScope, createPriceList, publishDocument, publishPriceList, setRate } from "@/lib/actions/price-lists";
import { cancelChange, startChange } from "@/lib/actions/price-books";
import { documentToChange } from "@/lib/actions/price-imports";
import { bookMatchesForDocument, crossReadFor, documentChangePreview } from "@/lib/services/price-import-service";
import { CROSS_READ_FEATURE } from "@/lib/price-ai/pdf-read";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

let TODAY: string;
let desk: typeof users.$inferSelect;
let nano20: typeof products.$inferSelect;
let nano5: typeof products.$inferSelect;
let pu5: typeof products.$inferSelect;

async function makeUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role: "associate",
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "accounts", role: "associate" });
  return row;
}

async function makeProduct(brand: string, name: string, millilitres: number, cansPerBox: number) {
  const formulationId = id("fml");
  const brandId = id("brn");
  const fgId = id("fgd");
  await db.insert(productFormulations).values({ id: formulationId, name: `F ${name}`, slug: id("s") });
  await db.insert(productBrands).values({ id: brandId, name: brand, slug: id("s"), formulationId });
  await db.insert(finishedGoods).values({ id: fgId, name: name.split(" (")[0], slug: id("s"), brandId, formulationId, millilitres });
  const [row] = await db
    .insert(products)
    .values({ id: id("prd"), name, millilitresPerCan: millilitres, cansPerBox, packing: `${cansPerBox} Can/Box`, finishedGoodId: fgId, brandId, formulationId })
    .returning();
  return row;
}

async function book(name: string, opts: { freightTerm: "to_pay" | "paid"; refNo: string; state: string; rates: Array<[typeof products.$inferSelect, number]> }) {
  const created = await createPriceList({ name, refNo: opts.refNo, effectiveFrom: addDays(TODAY, -40), freightTerm: opts.freightTerm, deliveryBasis: "for_godown" });
  assert.ok(created.ok, created.ok ? "" : created.error);
  for (const [product, incl] of opts.rates) {
    const r = await setRate({ priceListId: created.data.id, productId: product.id, rateInclGstPaise: incl });
    assert.ok(r.ok, r.ok ? "" : r.error);
  }
  assert.ok((await addScope({ priceListId: created.data.id, scopeKind: "state", scopeValue: key(opts.state), scopeLabel: opts.state })).ok);
  const published = await publishPriceList(created.data.id);
  assert.ok(published.ok, published.ok ? "" : published.error);
  const [row] = await db.select().from(priceLists).where(eq(priceLists.id, created.data.id));
  return row.bookId!;
}

/** A read document whose cells match the Odisha book's products, at new prices. */
async function stagedDocument(cells: Array<Partial<typeof priceListParseRows.$inferInsert>>, header: Record<string, unknown> = {}) {
  const documentId = id("pld");
  await db.insert(priceListDocuments).values({
    id: documentId,
    fileHash: randomUUID(),
    filename: "Odisha to pay November.pdf",
    parseStatus: "needs_review",
    header: {
      listName: "Odisha To Pay — November 2026",
      refNo: "PL0201",
      effectiveFrom: addDays(TODAY, 10),
      taxBasis: "inclusive",
      gstBp: 1800,
      freightTerm: "to_pay",
      deliveryBasis: "for_godown",
      validityDays: 30,
      signatory: null,
      ...header,
    } as never,
    filenameHints: { region: "Odisha", freightTerm: "to_pay", monthIso: null, customer: null, tokens: ["odisha"] } as never,
    uploadedById: desk.id,
  });
  await db.insert(priceListParseRows).values(
    cells.map((c, i) => ({
      id: id("plp"),
      documentId,
      rowIndex: i,
      colIndex: 0,
      rawProductText: "Nano Thinner",
      rawPackText: "20 Ltr",
      offered: true,
      matchStatus: "matched" as const,
      ...c,
    })),
  );
  return documentId;
}

const odishaCells = () => [
  { matchedProductId: nano20.id, rateInclGstPaise: 240_000, rateExGstPaise: exFromIncl(240_000, 1800), rawPackText: "20 Ltr", millilitres: 20000 },
  { matchedProductId: nano5.id, rateInclGstPaise: 61_000, rateExGstPaise: exFromIncl(61_000, 1800), rawPackText: "5 Ltr", millilitres: 5000 },
  { matchedProductId: pu5.id, rateInclGstPaise: 70_000, rateExGstPaise: exFromIncl(70_000, 1800), rawProductText: "PU Thinner", rawPackText: "5 Ltr", millilitres: 5000 },
];

let odisha: string;
let gujarat: string;

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
      audit_log, notifications, attachments,
      app_module_access, app_access, sessions, users,
      products, finished_goods, product_brands, product_formulations,
      app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  desk = await makeUser("Deepa");
  setTestUser(desk);
  nano20 = await makeProduct("Nano Thinner", "Nano Thinner - 20 Liter (2 Can/Box)", 20000, 2);
  nano5 = await makeProduct("Nano Thinner", "Nano Thinner - 5 Liter (4 Can/Box)", 5000, 4);
  pu5 = await makeProduct("PU Thinner", "PU Thinner - 5 Liter (4 Can/Box)", 5000, 4);
  odisha = await book("Odisha To Pay", { freightTerm: "to_pay", refNo: "PL0200", state: "Odisha", rates: [[nano20, 228_600], [nano5, 58_400], [pu5, 66_000]] });
  gujarat = await book("Gujarat Paid", { freightTerm: "paid", refNo: "GJ100", state: "Gujarat", rates: [[nano5, 59_000]] });
});

describe("which book a PDF belongs to", () => {
  test("the book it is next month's copy of ranks first, and is named the winner", async () => {
    const documentId = await stagedDocument(odishaCells());
    const match = await bookMatchesForDocument(documentId);
    assert.ok(match);
    assert.equal(match.candidates[0].bookId, odisha);
    assert.equal(match.winner?.bookId, odisha);
    assert.ok(match.candidates.some((c) => c.bookId === gujarat));
    assert.ok(match.candidates[0].reasons.length >= 3);
    assert.equal(match.refusal, null);
  });

  test("the preview puts every cell beside the book's price today", async () => {
    const documentId = await stagedDocument(odishaCells());
    const preview = await documentChangePreview(documentId, odisha);
    assert.ok(preview);
    const nano = preview.rows.find((r) => r.productId === nano20.id)!;
    assert.equal(nano.beforeIncl, 228_600);
    assert.equal(nano.afterIncl, 240_000);
    assert.equal(nano.kind, "up");
    assert.ok(nano.changeBp! > 0);
    assert.equal(preview.counts.up, 3);
    assert.deepEqual(preview.blockers, []);
  });
});

describe("a document made a change", () => {
  test("the change's draft carries the document's prices and the document is consumed", async () => {
    const documentId = await stagedDocument(odishaCells());
    const made = await documentToChange(documentId, odisha);
    assert.ok(made.ok, made.ok ? "" : made.error);

    const [change] = await db.select().from(priceChanges).where(eq(priceChanges.id, made.data.changeId));
    assert.equal(change.source, "import");
    assert.equal(change.sourceDocumentId, documentId);
    assert.equal(change.status, "draft");
    assert.equal(change.goLive, addDays(TODAY, 10), "the paper's own date, still to come, is the go-live");

    const rates = await db.select().from(priceListRates).where(eq(priceListRates.priceListId, change.draftListId));
    assert.equal(rates.length, 3);
    assert.equal(Number(rates.find((r) => r.productId === nano20.id)!.rateInclGstPaise), 240_000);

    const [draft] = await db.select().from(priceLists).where(eq(priceLists.id, change.draftListId));
    assert.equal(draft.status, "draft");
    assert.equal(draft.bookId, odisha);
    assert.equal(draft.refNo, "PL0201");
    assert.equal(draft.effectiveFrom, addDays(TODAY, 10));

    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, documentId));
    assert.equal(doc.parseStatus, "published");
    assert.equal(doc.priceListId, change.draftListId);
    assert.ok(doc.publishedAt);

    const events = await db.select().from(priceChangeEvents).where(eq(priceChangeEvents.changeId, change.id));
    assert.ok(events.some((e) => e.kind === "imported"));

    // A second attempt is refused: the document is spent.
    const again = await documentToChange(documentId, odisha);
    assert.equal(again.ok, false);
    const match = await bookMatchesForDocument(documentId);
    assert.equal(match?.madeChange?.changeId, change.id);
  });

  test("cancelling the change hands the document back for review", async () => {
    const documentId = await stagedDocument(odishaCells());
    const made = await documentToChange(documentId, odisha);
    assert.ok(made.ok, made.ok ? "" : made.error);
    const cancelled = await cancelChange(made.data.changeId, "Wrong month");
    assert.ok(cancelled.ok, cancelled.ok ? "" : cancelled.error);
    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, documentId));
    assert.equal(doc.parseStatus, "needs_review");
    assert.equal(doc.priceListId, null);
    // And it can be brought in again.
    const again = await documentToChange(documentId, odisha);
    assert.ok(again.ok, again.ok ? "" : again.error);
  });

  test("a book with a change already open refuses, naming it", async () => {
    const started = await startChange(odisha, { title: "Diwali" });
    assert.ok(started.ok);
    const documentId = await stagedDocument(odishaCells());
    const r = await documentToChange(documentId, odisha);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /Diwali/);
    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, documentId));
    assert.equal(doc.parseStatus, "needs_review", "nothing was spent");
  });

  test("a price with no product, or two cells pricing one product differently, block it", async () => {
    const held = await stagedDocument([...odishaCells(), { matchedProductId: null, matchStatus: "held", rateInclGstPaise: 9_900, rawProductText: "Mystery" }]);
    const r1 = await documentToChange(held, odisha);
    assert.equal(r1.ok, false);
    assert.match(r1.ok ? "" : r1.error, /no product/);

    const clash = await stagedDocument([...odishaCells(), { matchedProductId: nano20.id, rateInclGstPaise: 250_000, colIndex: 1 }]);
    const r2 = await documentToChange(clash, odisha);
    assert.equal(r2.ok, false);
    assert.match(r2.ok ? "" : r2.error, /same product differently/);
  });

  test("the old road still makes a new list", async () => {
    const documentId = await stagedDocument(odishaCells());
    const r = await publishDocument(documentId, {
      name: "Odisha To Pay — November",
      effectiveFrom: TODAY,
      taxBasis: "inclusive",
      gstBp: 1800,
      freightTerm: "to_pay",
      publishNow: false,
      includeSuggested: false,
    });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const [list] = await db.select().from(priceLists).where(eq(priceLists.id, r.data.priceListId));
    assert.notEqual(list.bookId, odisha, "a new list is a new book");
    assert.equal((await db.select().from(priceChanges)).length, 0);
  });
});

describe("three readers", () => {
  test("a cell is agreed only where both models print the text reader's figure", async () => {
    const documentId = await stagedDocument(odishaCells());
    const run = (provider: string, cells: Array<{ product: string; pack: string; pricePaise: number | null }>) =>
      db.insert(priceAiRuns).values({
        id: id("pai"),
        subjectKind: "price_list_document",
        subjectId: documentId,
        feature: CROSS_READ_FEATURE,
        provider,
        model: "m",
        ok: true,
        output: { cells } as never,
      });
    await run("openai", [
      { product: "Nano Thinner", pack: "20 Ltr", pricePaise: 240_000 },
      { product: "Nano Thinner", pack: "5 Ltr", pricePaise: 61_000 },
      { product: "PU Thinner", pack: "5 Ltr", pricePaise: 70_000 },
    ]);
    await run("anthropic", [
      { product: "Nano Thinner", pack: "20 L", pricePaise: 240_000 },
      { product: "Nano Thinner", pack: "5 L", pricePaise: 16_000 },
      { product: "PU Thinner", pack: "5 L", pricePaise: 70_000 },
    ]);
    const view = await crossReadFor(documentId);
    assert.ok(view.ran);
    assert.deepEqual(view.counts, { agree: 2, disagree: 1, unseen: 0 });
    const bad = view.cells.find((c) => c.verdict === "disagree")!;
    assert.equal(bad.text, 61_000);
    assert.equal(bad.openai, 61_000);
    assert.equal(bad.anthropic, 16_000);
  });

  test("before any model has read it, nothing is compared", async () => {
    const documentId = await stagedDocument(odishaCells());
    const view = await crossReadFor(documentId);
    assert.equal(view.ran, false);
    assert.equal(view.cells.length, 0);
  });
});
