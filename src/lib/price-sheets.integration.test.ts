/**
 * PRICE LISTS MADE HERE, END TO END.
 *
 * `price-sheet.test.ts` proves the paper reads back as typed with no
 * database. What only a database can show is the rest of the round trip: that
 * the editor's sheet becomes exactly the rates it shows, that publishing it
 * stores the PDF as the list's own document with every cell verified, that a
 * published list is versioned rather than rewritten, that a duplicate is a
 * draft of its own, that the bulk actions leave published lists alone — and
 * that a Sales Dashboard manager, who could change a price list the day this
 * module shipped, now cannot.
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
import { exFromIncl } from "@/lib/engines/price-math";
import { columnOf, familiesOf, skuFor, type PriceSheet, type SheetProduct } from "@/lib/price-sheet";
import {
  deleteDraftPriceLists,
  duplicatePriceList,
  publishDraftPriceLists,
  savePriceSheet,
} from "@/lib/actions/price-sheets";
import { sheetForList } from "@/lib/services/price-sheet-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let TODAY: string;
let desk: typeof users.$inferSelect;
let salesManager: typeof users.$inferSelect;
let catalogue: SheetProduct[];

async function makeUser(name: string, grants: Array<{ app: "sales" | "accounts" | "founder" | "crm"; role: "associate" | "manager" }>) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
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

/** A sheet over the whole test catalogue, every cell priced from a table. */
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
    discounts: [{ kind: "advance_payment", percentBp: 300, thresholdLitres: null, thresholdPaise: null }],
    signatory: "Heena Doshi",
    signatoryTitle: "Account Team Head",
    ...over,
  };
}

const PRICES = {
  "Nano Thinner - 1 Liter (32 Can/Box)": 13_500,
  "Nano Thinner - 20 Liter (2 Can/Box)": 252_100,
  "Universal Thinner - 1 Liter (32 Can/Box)": 17_000,
  "Universal Thinner - 20 Liter (2 Can/Box)": 318_700,
};

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
  await db.execute(sql`
    truncate table
      price_list_parse_rows, price_list_rates, price_list_scopes,
      price_list_discount_terms, price_requests, price_lists,
      price_list_documents, audit_log, notifications, attachments,
      app_access, sessions, users,
      products, finished_goods, product_brands, product_formulations,
      app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  desk = await makeUser("Deepa", [{ app: "accounts", role: "associate" }]);
  salesManager = await makeUser("Vikram", [{ app: "sales", role: "manager" }, { app: "crm", role: "manager" }]);
  await makeProduct("Maruti Nano Thinner", "Nano Thinner - 1 Liter (32 Can/Box)", 1000, 32, "32 Can/Box");
  await makeProduct("Maruti Nano Thinner", "Nano Thinner - 20 Liter (2 Can/Box)", 20000, 2, "2 Can/Box");
  await makeProduct("Mahek Universal Thinner", "Universal Thinner - 1 Liter (32 Can/Box)", 1000, 32, "32 Can/Box");
  await makeProduct("Mahek Universal Thinner", "Universal Thinner - 20 Liter (2 Can/Box)", 20000, 2, "2 Can/Box");
  const rows = await db.execute<SheetProduct>(sql`
    select p.id, p.name, p.millilitres_per_can as "millilitresPerCan", p.cans_per_box as "cansPerBox",
           p.packing, b.name as "brandName", f.name as "formulationName", p.active
      from products p left join product_brands b on b.id = p.brand_id left join product_formulations f on f.id = p.formulation_id
  `);
  catalogue = [...rows];
  setTestUser(desk);
});

describe("who may change a price list", () => {
  test("a Sales Dashboard and CRM manager is refused — they read price lists, they do not set them", async () => {
    setTestUser(salesManager);
    const r = await savePriceSheet({ mode: "create", sheet: sheetOf(PRICES) });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? null : r.code, "not_permitted");
  });

  test("an Accounts associate may, which is the accounts team Mahek named", async () => {
    const r = await savePriceSheet({ mode: "create", sheet: sheetOf(PRICES) });
    assert.ok(r.ok, r.ok ? "" : r.error);
  });
});

describe("a list built in the editor", () => {
  test("becomes exactly the rates the grid shows, ex-GST derived from what was printed", async () => {
    const r = await savePriceSheet({ mode: "create", sheet: sheetOf(PRICES), scopes: [{ kind: "everybody" }] });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const rates = await db.select().from(priceListRates).where(eq(priceListRates.priceListId, r.data.listId));
    assert.equal(rates.length, 4);
    const nano20 = catalogue.find((p) => p.name.startsWith("Nano Thinner - 20"))!;
    const rate = rates.find((x) => x.productId === nano20.id)!;
    assert.equal(Number(rate.rateInclGstPaise), 252_100);
    assert.equal(Number(rate.rateExGstPaise), exFromIncl(252_100, 1800));
    assert.equal(rate.rawProductText, "Maruti Nano Thinner", "what the paper printed is kept on the rate");
    const [list] = await db.select().from(priceLists).where(eq(priceLists.id, r.data.listId));
    assert.equal(list.status, "draft");
    assert.equal(list.signatory, "Heena Doshi\nAccount Team Head");
  });

  test("reads back through sheetForList as the same sheet it was saved from", async () => {
    const r = await savePriceSheet({ mode: "create", sheet: sheetOf(PRICES) });
    assert.ok(r.ok);
    const back = await sheetForList(r.data.listId);
    assert.ok(back);
    assert.equal(back.sheet.signatory, "Heena Doshi");
    assert.equal(back.sheet.signatoryTitle, "Account Team Head");
    assert.equal(back.sheet.discounts[0].percentBp, 300);
    assert.deepEqual(back.sheet.terms, ["All prices are inclusive of GST @ 18%."]);
    const nano = back.sheet.rows.find((row) => row.label === "Maruti Nano Thinner")!;
    assert.deepEqual(
      Object.values(nano.cells).map((c) => c.printedPaise).sort(),
      [13_500, 252_100].sort(),
    );
  });

  test("publishing stores its PDF as the list's own document, every cell read back and verified", async () => {
    const r = await savePriceSheet({ mode: "create", sheet: sheetOf(PRICES), scopes: [{ kind: "everybody" }], publish: {} });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(r.data.published, true);
    assert.equal(r.data.readBackOk, true);
    const [list] = await db.select().from(priceLists).where(eq(priceLists.id, r.data.listId));
    assert.equal(list.status, "published");
    assert.equal(list.documentId, r.data.documentId);
    const [doc] = await db.select().from(priceListDocuments).where(eq(priceListDocuments.id, r.data.documentId!));
    assert.equal(doc.parseStatus, "published");
    assert.deepEqual(doc.problems, []);
    const staged = await db.select().from(priceListParseRows).where(eq(priceListParseRows.documentId, doc.id));
    assert.ok(staged.filter((s) => s.matchedProductId).length >= 4);
    assert.ok(staged.every((s) => !s.problem), "no cell read back differently from what was typed");
  });

  test("a list with no prices cannot be put in force, and says so rather than publishing an empty sheet", async () => {
    const r = await savePriceSheet({ mode: "create", sheet: sheetOf({}), publish: {} });
    assert.equal(r.ok, false);
  });

  test("a published list is never rewritten: editing it makes a new version that supersedes it on publish", async () => {
    const first = await savePriceSheet({ mode: "create", sheet: sheetOf(PRICES), scopes: [{ kind: "everybody" }], publish: {} });
    assert.ok(first.ok);
    const refused = await savePriceSheet({ mode: "update", listId: first.data.listId, sheet: sheetOf(PRICES) });
    assert.equal(refused.ok, false);

    const raised = Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, v + 1_000]));
    const second = await savePriceSheet({ mode: "version", listId: first.data.listId, sheet: sheetOf(raised), publish: {} });
    assert.ok(second.ok, second.ok ? "" : second.error);
    const [old] = await db.select().from(priceLists).where(eq(priceLists.id, first.data.listId));
    const [now] = await db.select().from(priceLists).where(eq(priceLists.id, second.data.listId));
    assert.equal(old.status, "superseded");
    assert.equal(now.version, 2);
    assert.equal(now.supersedesId, old.id);
    const scopes = await db.select().from(priceListScopes).where(eq(priceListScopes.priceListId, now.id));
    assert.equal(scopes.length, 1, "a new version with no scopes of its own inherits the old one's");
  });
});

describe("duplicating and the bulk actions", () => {
  test("a duplicate is a draft of its own, with every price and none of the scopes unless asked", async () => {
    const src = await savePriceSheet({ mode: "create", sheet: sheetOf(PRICES), scopes: [{ kind: "everybody" }], publish: {} });
    assert.ok(src.ok);
    const copy = await duplicatePriceList(src.data.listId, { name: "Odisha copy", effectiveFrom: TODAY, copyScopes: false });
    assert.ok(copy.ok, copy.ok ? "" : copy.error);
    const [row] = await db.select().from(priceLists).where(eq(priceLists.id, copy.data.id));
    assert.equal(row.status, "draft");
    assert.equal(row.version, 1);
    assert.equal(row.supersedesId, null);
    assert.equal((await db.select().from(priceListRates).where(eq(priceListRates.priceListId, copy.data.id))).length, 4);
    assert.equal((await db.select().from(priceListScopes).where(eq(priceListScopes.priceListId, copy.data.id))).length, 0);

    const withScopes = await duplicatePriceList(src.data.listId, { name: "Odisha copy 2", effectiveFrom: TODAY, copyScopes: true });
    assert.ok(withScopes.ok);
    assert.equal((await db.select().from(priceListScopes).where(eq(priceListScopes.priceListId, withScopes.data.id))).length, 1);
  });

  test("bulk delete takes the drafts and leaves a published list alone", async () => {
    const live = await savePriceSheet({ mode: "create", sheet: sheetOf(PRICES), scopes: [{ kind: "everybody" }], publish: {} });
    const draft = await savePriceSheet({ mode: "create", sheet: sheetOf(PRICES, { name: "A draft" }) });
    assert.ok(live.ok && draft.ok);
    const r = await deleteDraftPriceLists([live.data.listId, draft.data.listId]);
    assert.ok(r.ok);
    assert.deepEqual(r.data.outcomes.map((o) => o.ok).sort(), [false, true]);
    assert.equal((await db.select().from(priceLists).where(eq(priceLists.id, live.data.listId))).length, 1);
    assert.equal((await db.select().from(priceLists).where(eq(priceLists.id, draft.data.listId))).length, 0);
  });

  test("bulk publish puts every draft in force through the one-at-a-time checks", async () => {
    const a = await savePriceSheet({ mode: "create", sheet: sheetOf(PRICES, { name: "A" }), scopes: [{ kind: "everybody" }] });
    const empty = await savePriceSheet({ mode: "create", sheet: sheetOf({}, { name: "Empty" }) });
    assert.ok(a.ok && empty.ok);
    const r = await publishDraftPriceLists([a.data.listId, empty.data.listId]);
    assert.ok(r.ok);
    const byName = Object.fromEntries(r.data.outcomes.map((o) => [o.name, o.ok]));
    assert.equal(byName.A, true);
    assert.equal(byName.Empty, false, "a draft with no prices is refused, exactly as it would be alone");
  });

  test("a Sales Dashboard manager cannot duplicate or bulk-delete either", async () => {
    const src = await savePriceSheet({ mode: "create", sheet: sheetOf(PRICES) });
    assert.ok(src.ok);
    setTestUser(salesManager);
    assert.equal((await duplicatePriceList(src.data.listId, { name: "x", effectiveFrom: TODAY, copyScopes: false })).ok, false);
    assert.equal((await deleteDraftPriceLists([src.data.listId])).ok, false);
  });
});
