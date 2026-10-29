/**
 * THE PRICE-LIST EDITOR AND THE IMPORT, held to what they promise.
 *
 * No database: every rule here is pure — the sheet's own checks, the CSV
 * reader, which staged cell becomes a rate, how a corrected header re-states
 * a printed figure, when a read counts as stuck — plus a MahekOne PDF drawn
 * and read back through the same extractor, parser and matcher an import
 * uses, so our own paper comes back as the list it was.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { extractText, getDocumentProxy } from "unpdf";
import { listNameFromMeta, parsePriceListText } from "@/lib/price-list-parse";
import { matchGrid, type CatalogueSku } from "@/lib/price-list-match";
import {
  checkSheet,
  columnOf,
  csvToCells,
  defaultTerms,
  familiesOf,
  MAX_SHEET_COLUMNS,
  publishRefusal,
  skuFor,
  sortColumns,
  type PriceSheet,
  type SheetColumn,
  type SheetProduct,
} from "@/lib/price-sheet";
import { renderPriceSheetPdf } from "@/lib/price-sheet-pdf";
import { parseCsv, toCsv } from "@/lib/csv";
import { catalogueSheet, pruneUnpricedColumns, blankSheet, setCell } from "@/components/pricing/editor/editor-state";
import {
  canReread,
  isStuck,
  pickDocumentRates,
  printedOf,
  restage,
  STALE_READ_MS,
  stagedFigures,
  type PublishCell,
} from "@/lib/engines/price-document";

const P = (id: string, name: string, ml: number, cpb: number | null, packing: string, brand: string): SheetProduct => ({
  id,
  name,
  millilitresPerCan: ml,
  cansPerBox: cpb,
  packing,
  brandName: brand,
  formulationName: null,
  active: true,
});

const CATALOGUE: SheetProduct[] = [
  P("n05", "Nano Thinner - 500 ML (50 Can/Box)", 500, 50, "50 Can/Box", "Maruti Nano Thinner"),
  P("n1", "Nano Thinner - 1 Liter (32 Can/Box)", 1000, 32, "32 Can/Box", "Maruti Nano Thinner"),
  P("n20", "Nano Thinner - 20 Liter (2 Can/Box)", 20000, 2, "2 Can/Box", "Maruti Nano Thinner"),
  P("n20t", "Nano Thinner - 20 Liter Tin Can (Loose)", 20000, 1, "Tin Can Loose", "Maruti Nano Thinner"),
  P("d210", "Nano Thinner - 210 Liter Drum", 210000, 1, "Drum", "Maruti Nano Thinner"),
  P("u1", "Universal Thinner - 1 Liter (32 Can/Box)", 1000, 32, "32 Can/Box", "Mahek Universal Thinner"),
  P("u20", "Universal Thinner - 20 Liter (2 Can/Box)", 20000, 2, "2 Can/Box", "Mahek Universal Thinner"),
  P("p5", "PU Thinner - 5 Liter", 5000, null, "", "Mahek PU Thinner"),
  P("p1", "PU Thinner - 1 Liter (24 Can/Box)", 1000, 24, "24 Can/Box", "Mahek PU Thinner"),
];

function sheetOf(catalogue: SheetProduct[] = CATALOGUE, opts?: { signatory?: string | null }): PriceSheet {
  const families = familiesOf(catalogue);
  const columns = sortColumns([...new Map(catalogue.map((p) => [columnOf(p).key, columnOf(p)])).values()]);
  const rows = families.map((f) => ({
    key: f.key,
    label: f.name,
    familyKey: f.key,
    cells: Object.fromEntries(
      columns.map((c, i) => {
        const sku = skuFor(f, c);
        return [c.key, { productId: sku?.id ?? null, printedPaise: sku ? 100_000 + i * 1_000 : null, offered: !!sku }];
      }),
    ),
  }));
  return {
    name: "Odisha To Pay — August 2026",
    refNo: "PL0105",
    effectiveFrom: "2026-08-01",
    validityDays: 30,
    taxBasis: "inclusive",
    gstBp: 1800,
    deliveryBasis: "for_godown",
    freightTerm: "paid",
    columns,
    rows,
    terms: defaultTerms({ effectiveFrom: "2026-08-01", gstBp: 1800, taxBasis: "inclusive", deliveryBasis: "for_godown", validityDays: 30 }),
    discounts: [],
    signatory: opts?.signatory === undefined ? "Heena Doshi" : opts.signatory,
    signatoryTitle: opts?.signatory === null ? null : "Account Team Head",
  };
}

async function readBack(bytes: Uint8Array) {
  const pdf = await getDocumentProxy(bytes.slice());
  const { text } = await extractText(pdf, { mergePages: false });
  const { info } = await pdf.getMetadata();
  const i = (info ?? {}) as { Title?: string; Creator?: string };
  return parsePriceListText((Array.isArray(text) ? text : [text]).map((p) => p ?? ""), { title: i.Title ?? null, creator: i.Creator ?? null });
}

/* ------------------------------------------------------- B29: round trip */

describe("our own PDF imported again", () => {
  test("the list's name comes back from the PDF, not rebuilt from the freight term and the date", async () => {
    const sheet = sheetOf();
    const parsed = await readBack(await renderPriceSheetPdf(sheet));
    assert.equal(parsed.header.listName, sheet.name);
  });

  test("somebody else's PDF title is never taken as a list name", () => {
    assert.equal(listNameFromMeta({ title: "Microsoft Word - Odisha.docx", creator: "Word" }), null);
    assert.equal(listNameFromMeta({ title: "Price lists (3)", creator: "MahekOne" }), null);
    assert.equal(listNameFromMeta({ title: "Odisha Paid", creator: "MahekOne" }), "Odisha Paid");
    assert.equal(listNameFromMeta(null), null);
  });

  test("on a two-page list nobody signs, the page counter is not the signatory", async () => {
    const sheet = sheetOf(CATALOGUE, { signatory: null });
    const many = Array.from({ length: 70 }, (_, i) => ({ ...sheet.rows[i % sheet.rows.length], key: `r${i}`, label: `Line ${i} Thinner` }));
    const long = { ...sheet, rows: many };
    const bytes = await renderPriceSheetPdf(long);
    assert.ok((await getDocumentProxy(bytes.slice())).numPages >= 2);
    const parsed = await readBack(bytes);
    assert.equal(parsed.header.signatory, null);
    assert.ok(!parsed.rows.some((r) => /^Page \d/.test(r.rawProduct)));
  });

  test("a page counter never reaches the signatory, even straight after the sign-off", () => {
    const parsed = parsePriceListText(["PRICE LIST\nFor Mahek Marketing India\nPage 2 of 2\n"]);
    assert.equal(parsed.header.signatory, null);
    const signed = parsePriceListText(["PRICE LIST\nFor Mahek Marketing India\nHeena Doshi\nAccount Team Head\n"]);
    assert.equal(signed.header.signatory, "Heena Doshi");
  });

  test("every priced cell matches the SKU it was printed for — single cans, drums and tins included", async () => {
    const sheet = sheetOf();
    const parsed = await readBack(await renderPriceSheetPdf(sheet));
    const skus: CatalogueSku[] = CATALOGUE.map((p) => ({ ...p, finishedGoodId: p.id }));
    const matches = matchGrid(parsed, skus, []);
    let priced = 0;
    sheet.rows.forEach((row, r) => {
      sheet.columns.forEach((column, c) => {
        const cell = row.cells[column.key];
        if (!cell?.productId) return;
        priced++;
        const m = matches.get(`${parsed.rows[r].rowIndex}:${c}`);
        assert.equal(m?.productId, cell.productId, `${row.label} ${column.sizeLabel} ${column.packLabel}`);
        assert.equal(m?.status, "matched", `${row.label} ${column.sizeLabel} ${column.packLabel}`);
      });
    });
    assert.equal(priced, CATALOGUE.length);
  });
});

/* --------------------------------------------------- B14, B22: the editor */

describe("what the editor refuses before a list goes into force", () => {
  test("a ₹0 price refuses publishing on the server's own check", () => {
    const sheet = sheetOf();
    const priced = Object.values(sheet.rows[0].cells).find((c) => c.productId)!;
    priced.printedPaise = 0;
    assert.match(publishRefusal(sheet) ?? "", /zero/);
    assert.equal(publishRefusal(sheetOf()), null);
  });

  test("more pack columns than the page holds is a block that says how to fix it", () => {
    const sheet = sheetOf();
    const columns = Array.from({ length: MAX_SHEET_COLUMNS + 1 }, (_, i) => ({ ...sheet.columns[0], key: `k${i}` }));
    const block = checkSheet({ ...sheet, columns }, { todayIso: "2026-07-01" }).find((c) => c.code === "columns");
    assert.equal(block?.level, "block");
    assert.match(block!.message, /Remove pack columns with no prices/);
    assert.match(publishRefusal({ ...sheet, columns }) ?? "", /24 pack sizes/);
  });

  test("starting from every active product fits on the page", () => {
    // Thirty packs, one product each: more columns than the paper holds.
    const wide: SheetProduct[] = Array.from({ length: 30 }, (_, i) =>
      P(`w${i}`, `Wide Thinner - ${(i + 1) * 100} ML (10 Can/Box)`, (i + 1) * 100, 10, "10 Can/Box", i < 5 ? "Mahek Wide" : `Line ${i}`),
    );
    const sheet = catalogueSheet(blankSheet("2026-08-01", 1800), familiesOf(wide));
    assert.equal(sheet.columns.length, MAX_SHEET_COLUMNS);
    for (const row of sheet.rows) for (const k of Object.keys(row.cells)) assert.ok(sheet.columns.some((c) => c.key === k));
  });

  test("Tidy removes the pack columns with no price in any cell, and keeps the priced ones", () => {
    let sheet = catalogueSheet(blankSheet("2026-08-01", 1800), familiesOf(CATALOGUE));
    const first = sheet.columns[0] as SheetColumn;
    const row = sheet.rows.find((r) => r.cells[first.key]?.productId)!;
    sheet = setCell(sheet, row.key, first.key, { printedPaise: 12_300 });
    const tidy = pruneUnpricedColumns(sheet);
    assert.deepEqual(tidy.columns.map((c) => c.key), [first.key]);
    for (const r of tidy.rows) assert.deepEqual(Object.keys(r.cells), [first.key]);
  });
});

/* ------------------------------------------------------- B38, B39: CSV */

describe("spreadsheets in and out", () => {
  test("a CSV holding two lists that both price one product is refused, naming the lists", () => {
    const rows = [
      { List: "Odisha To Pay", "Product ID": "n1", "Rate incl GST (Rs)": "135" },
      { List: "Odisha Paid", "Product ID": "n1", "Rate incl GST (Rs)": "147" },
    ];
    assert.throws(() => csvToCells(rows, CATALOGUE, "inclusive", 1800), /2 price lists .*Odisha To Pay.*Odisha Paid/);
    const one = csvToCells([rows[0], { List: "Odisha To Pay", "Product ID": "n20", "Rate incl GST (Rs)": "2521" }], CATALOGUE, "inclusive", 1800);
    assert.equal(one.cells.length, 2);
  });

  test("a cell that would run as a formula is quoted, and reads back as typed", () => {
    const csv = toCsv(["Product", "Rate"], [['=HYPERLINK("x")', "-12"], ["@SUM(A1)", "+91 98200 11001"], ["-", "+"]]);
    assert.match(csv, /"'=HYPERLINK/);
    assert.match(csv, /"'@SUM/);
    assert.match(csv, /"-12"/);
    assert.match(csv, /"\+91 98200 11001"/);
    assert.match(csv, /\n"-","\+"$/);
    const back = parseCsv(csv);
    assert.equal(back[0].Product, '=HYPERLINK("x")');
    assert.equal(back[1].Product, "@SUM(A1)");
  });
});

/* ------------------------------------------- B24, B31, B32, B40: figures */

describe("a staged figure and what it prints", () => {
  test("a GST-extra list stages the printed ex figure and grosses it up beside it", () => {
    assert.deepEqual(stagedFigures(100_000, "exclusive", 1800), { ex: 100_000, incl: 118_000 });
    assert.deepEqual(stagedFigures(118_000, "inclusive", 1800), { incl: 118_000, ex: 100_000 });
    assert.deepEqual(stagedFigures(null, "inclusive", 1800), { incl: null, ex: null });
  });

  test("correcting the tax basis re-states the figures from what the paper printed", () => {
    const readInclusive = stagedFigures(118_000, "inclusive", 1800);
    // Somebody says: these figures were GST-extra after all.
    const fixed = restage({ rateInclGstPaise: readInclusive.incl, rateExGstPaise: readInclusive.ex }, { basis: "inclusive", gstBp: 1800 }, { basis: "exclusive", gstBp: 1800 });
    assert.deepEqual(fixed, { ex: 118_000, incl: 139_240 });
    // And a GST rate corrected on an inclusive list keeps the printed figure.
    const rate = restage({ rateInclGstPaise: 112_000, rateExGstPaise: 100_000 }, { basis: "inclusive", gstBp: 1200 }, { basis: "inclusive", gstBp: 1800 });
    assert.equal(rate.incl, 112_000);
    assert.equal(rate.ex, Math.round((112_000 * 10_000) / 11_800));
    assert.equal(printedOf({ rateInclGstPaise: 139_240, rateExGstPaise: 118_000 }, "exclusive", 1800), 118_000);
  });

  const cell = (over: Partial<PublishCell>): PublishCell => ({
    matchedProductId: "n1",
    rateExGstPaise: null,
    rateInclGstPaise: null,
    offered: true,
    matchStatus: "matched",
    rawProductText: "Nano",
    rowIndex: 0,
    colIndex: 0,
    ...over,
  });
  const IN = { basis: "inclusive" as const, gstBp: 1800 };

  test("a blank cell above never pushes out the real price below it", () => {
    const pick = pickDocumentRates([cell({ rowIndex: 0 }), cell({ rowIndex: 1, rateInclGstPaise: 236_000, rateExGstPaise: 200_000 })], IN, IN);
    assert.equal(pick.chosen.length, 1);
    assert.equal(pick.chosen[0].incl, 236_000);
  });

  test("the inclusive figure stored is the one printed, never rebuilt a paisa away", () => {
    // 2,281 printed: ex 1,933.05, and inclFromEx(193305) is 2,281.00 — but a
    // printed ₹2,280.94 must stay ₹2,280.94.
    const pick = pickDocumentRates([cell({ rateInclGstPaise: 228_094, rateExGstPaise: 193_300 })], IN, IN);
    assert.equal(pick.chosen[0].incl, 228_094);
  });

  test("a confirmed cell beats a suggestion for the same SKU", () => {
    const pick = pickDocumentRates(
      [
        cell({ rowIndex: 0, matchStatus: "suggested", rateInclGstPaise: 500_000 }),
        cell({ rowIndex: 3, matchStatus: "matched", rateInclGstPaise: 135_000 }),
      ],
      IN,
      IN,
    );
    assert.equal(pick.conflicts.length, 0);
    assert.equal(pick.chosen[0].incl, 135_000);
    assert.equal(pick.dropped, 1);
  });

  test("two confirmed cells printing different prices for one SKU are a conflict, never a guess", () => {
    const pick = pickDocumentRates(
      [cell({ rowIndex: 0, rateInclGstPaise: 135_000 }), cell({ rowIndex: 2, rateInclGstPaise: 147_000, matchStatus: "manual", rawProductText: "Nano again" })],
      IN,
      IN,
    );
    assert.equal(pick.chosen.length, 0);
    assert.deepEqual(pick.conflicts[0].prices, [135_000, 147_000]);
    // The same price twice is one rate, quietly.
    const same = pickDocumentRates([cell({ rateInclGstPaise: 135_000 }), cell({ rowIndex: 1, rateInclGstPaise: 135_000 })], IN, IN);
    assert.equal(same.conflicts.length, 0);
    assert.equal(same.chosen.length, 1);
  });

  test("a price beats a dash; a dash alone is kept as not offered", () => {
    const pick = pickDocumentRates([cell({ offered: false }), cell({ rowIndex: 1, rateInclGstPaise: 135_000 })], IN, IN);
    assert.equal(pick.chosen[0].incl, 135_000);
    const dash = pickDocumentRates([cell({ offered: false })], IN, IN);
    assert.equal(dash.chosen[0].offered, false);
    assert.equal(dash.chosen[0].ex, null);
  });

  test("publishing under a corrected header works the rates out again from the printed figure", () => {
    const staged = stagedFigures(100_000, "inclusive", 1800);
    const pick = pickDocumentRates([cell({ rateInclGstPaise: staged.incl, rateExGstPaise: staged.ex })], IN, { basis: "exclusive", gstBp: 1800 });
    assert.equal(pick.chosen[0].ex, 100_000);
    assert.equal(pick.chosen[0].incl, 118_000);
  });
});

/* ------------------------------------------------ B36, B37: stuck reads */

describe("a read that is running, and one that died", () => {
  const now = Date.parse("2026-10-29T10:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  test("a fresh stage is reading, not stuck; an old one is stuck", () => {
    assert.equal(isStuck({ parseStatus: "matching", stageStartedAt: ago(60_000) }, now), false);
    assert.equal(isStuck({ parseStatus: "matching", stageStartedAt: ago(STALE_READ_MS + 1) }, now), true);
    assert.equal(isStuck({ parseStatus: "parsed", stageStartedAt: ago(STALE_READ_MS * 10) }, now), false);
  });

  test("a queued file nobody started is stuck once old", () => {
    assert.equal(isStuck({ parseStatus: "queued", stageStartedAt: null, createdAt: ago(60_000) }, now), false);
    assert.equal(isStuck({ parseStatus: "queued", stageStartedAt: null, createdAt: ago(STALE_READ_MS + 1) }, now), true);
  });

  test("Read again is offered only where the server would do it", () => {
    assert.equal(canReread({ parseStatus: "matching", stageStartedAt: ago(1_000) }, now), false);
    assert.equal(canReread({ parseStatus: "matching", stageStartedAt: ago(STALE_READ_MS + 1) }, now), true);
    assert.equal(canReread({ parseStatus: "published", stageStartedAt: null }, now), false);
    assert.equal(canReread({ parseStatus: "rejected", stageStartedAt: null }, now), false);
    assert.equal(canReread({ parseStatus: "needs_review", stageStartedAt: null }, now), true);
    assert.equal(canReread({ parseStatus: "failed", stageStartedAt: null }, now), true);
  });
});
