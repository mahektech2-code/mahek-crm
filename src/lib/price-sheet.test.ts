/**
 * THE PAPER READS BACK AS WHAT WAS TYPED.
 *
 * A price list MahekOne generates is only worth sending if the document says
 * what the list holds, and the cheapest proof of that is the one the import
 * already owns: read the PDF with the same extractor and the same parser that
 * read Mahek's own lists in, and compare. These tests do exactly that — no
 * database, no model — so a change to a label, a figure format or the layout
 * that would make a generated sheet unreadable fails here rather than in a
 * shop.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { parsePackColumn, parsePriceListText } from "@/lib/price-list-parse";
import {
  checkSheet,
  columnOf,
  compareReadBack,
  copyName,
  csvToCells,
  defaultTerms,
  discountClause,
  familiesOf,
  groupRupees,
  headerLine,
  packLabels,
  parseTypedRupees,
  printedPrice,
  sheetCsvRows,
  sheetRates,
  skuFor,
  splitTerms,
  CSV_HEADERS,
  type PriceSheet,
  type SheetProduct,
} from "@/lib/price-sheet";
import { renderPriceSheetPdf, renderPriceSheetsPdf } from "@/lib/price-sheet-pdf";
import { parseCsv, toCsv } from "@/lib/csv";
import { sheetFromRates } from "@/lib/price-sheet";
import { blankSheet, sheetFromProductCells } from "@/components/pricing/editor/editor-state";

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
  P("u1", "Universal Thinner - 1 Liter (32 Can/Box)", 1000, 32, "32 Can/Box", "Mahek Universal Thinner"),
  P("u20", "Universal Thinner - 20 Liter (2 Can/Box)", 20000, 2, "2 Can/Box", "Mahek Universal Thinner"),
];

function sheetOf(): PriceSheet {
  const families = familiesOf(CATALOGUE);
  const columns = [...new Map(CATALOGUE.map((p) => [columnOf(p).key, columnOf(p)])).values()];
  const price: Record<string, number | null> = { n05: 7_600, n1: 13_500, n20: 252_100, n20t: 272_100, u1: 17_000, u20: 318_700 };
  const rows = families.map((f) => ({
    key: f.key,
    label: f.name,
    familyKey: f.key,
    cells: Object.fromEntries(
      columns.map((c) => {
        const sku = skuFor(f, c);
        return [c.key, { productId: sku?.id ?? null, printedPaise: sku ? price[sku.id] : null, offered: !!sku }];
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
    columns: columns.sort((a, b) => (a.millilitres ?? 0) - (b.millilitres ?? 0)),
    rows,
    terms: defaultTerms({ effectiveFrom: "2026-08-01", gstBp: 1800, taxBasis: "inclusive", deliveryBasis: "for_godown", validityDays: 30 }),
    discounts: [{ kind: "advance_payment", percentBp: 300, thresholdLitres: null, thresholdPaise: null }],
    signatory: "Heena Doshi",
    signatoryTitle: "Account Team Head",
  };
}

async function readBack(bytes: Uint8Array) {
  // A copy: pdf.js TRANSFERS the buffer it is handed, which detaches it.
  const pdf = await getDocumentProxy(bytes.slice());
  const { text } = await extractText(pdf, { mergePages: false });
  return parsePriceListText((Array.isArray(text) ? text : [text]).map((p) => p ?? ""));
}

describe("the header strips", () => {
  test("every pack is labelled so the parser reads back the same pack", () => {
    const packs: Array<[number, "can" | "tin" | "drum" | "loose", number | null]> = [
      [500, "can", 50],
      [1000, "can", 32],
      [5000, "can", 6],
      [20000, "can", 2],
      [20000, "tin", 1],
      [20000, "loose", 1],
      [210000, "drum", 1],
      [250, "can", 1],
    ];
    for (const [ml, container, cpb] of packs) {
      const { sizeLabel, packLabel } = packLabels(ml, container, cpb);
      const read = parsePackColumn(sizeLabel, packLabel);
      assert.equal(read.millilitres, ml, `${sizeLabel} ${packLabel}`);
      assert.equal(read.container, container, `${sizeLabel} ${packLabel}`);
      assert.equal(read.cansPerBox, cpb, `${sizeLabel} ${packLabel}`);
    }
  });

  test("the header line reads back to the same reference, date, GST and freight", () => {
    const line = headerLine(sheetOf());
    assert.equal(line, "Ref. No. PL0105 | Effective: 01 August 2026 | GST 18% Inclusive | FOR Godown (Transportation paid)");
  });
});

describe("figures", () => {
  test("rupees are grouped the Indian way and keep their paise only when there are some", () => {
    assert.equal(groupRupees(116_800), "1,168");
    assert.equal(groupRupees(12_345_600), "1,23,456");
    assert.equal(groupRupees(116_850), "1,168.50");
    assert.equal(printedPrice({ productId: "x", printedPaise: 7_600, offered: true }), "Rs.76");
    assert.equal(printedPrice({ productId: "x", printedPaise: null, offered: false }), "—");
  });

  test("what somebody types is read as rupees, with or without the Rs and the commas", () => {
    assert.equal(parseTypedRupees("1,168"), 116_800);
    assert.equal(parseTypedRupees("Rs.1168.5"), 116_850);
    assert.equal(parseTypedRupees("₹ 76"), 7_600);
    assert.equal(parseTypedRupees("12a"), null);
    assert.equal(parseTypedRupees(""), null);
  });
});

describe("a generated PDF read back through the importer", () => {
  test("every cell, the header and the discount come back exactly", async () => {
    const sheet = sheetOf();
    const parsed = await readBack(await renderPriceSheetPdf(sheet));
    assert.equal(parsed.layout, "grid");
    const report = compareReadBack(sheet, parsed, new Map());
    assert.deepEqual(report.headerMismatches, []);
    assert.equal(report.priceMismatches, 0);
    assert.equal(report.missing, 0);
    assert.ok(report.ok);
    assert.equal(parsed.header.signatory, "Heena Doshi");
    assert.ok(parsed.discountTerms.some((d) => d.kind === "advance_payment" && d.percentBp === 300));
  });

  test("a list too long for one page still reads back as one grid", async () => {
    const sheet = sheetOf();
    const many = Array.from({ length: 70 }, (_, i) => ({
      ...sheet.rows[i % sheet.rows.length],
      key: `r${i}`,
      label: `Line ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))} Thinner`,
    }));
    const long = { ...sheet, rows: many };
    const bytes = await renderPriceSheetPdf(long);
    const pdf = await getDocumentProxy(bytes.slice());
    assert.ok(pdf.numPages >= 2);
    const report = compareReadBack(long, await readBack(bytes), new Map());
    assert.equal(report.priceMismatches, 0);
    assert.equal(report.missing, 0);
  });

  test("Mahek's own Odisha Paid list, re-drawn, reads back the same figures it was read from", async () => {
    const text = readFileSync(join(process.cwd(), "src/lib/fixtures/price-lists/odisha-paid-august-2026.txt"), "utf8");
    const original = parsePriceListText(text.split("\f"));
    const columns = original.columns.map((c) => {
      const container = (c.container ?? "can") as "can" | "tin" | "drum" | "loose";
      return { key: `c${c.colIndex}`, millilitres: c.millilitres, cansPerBox: c.cansPerBox, container, ...packLabels(c.millilitres, container, c.cansPerBox) };
    });
    const sheet: PriceSheet = {
      ...sheetOf(),
      refNo: original.header.refNo,
      effectiveFrom: original.header.effectiveFrom!,
      deliveryBasis: original.header.deliveryBasis,
      freightTerm: original.header.freightTerm ?? "not_stated",
      columns,
      rows: original.rows.map((r) => ({
        key: `r${r.rowIndex}`,
        label: r.rawProduct,
        familyKey: `r${r.rowIndex}`,
        cells: Object.fromEntries(r.cells.map((c) => [`c${c.colIndex}`, { productId: "x", printedPaise: c.inclPaise, offered: c.offered }])),
      })),
      discounts: [],
    };
    const again = await readBack(await renderPriceSheetPdf(sheet));
    for (const row of original.rows) {
      const back = again.rows[row.rowIndex];
      assert.equal(back.rawProduct, row.rawProduct);
      assert.deepEqual(
        back.cells.map((c) => c.inclPaise),
        row.cells.map((c) => c.inclPaise),
        row.rawProduct,
      );
    }
  });

  test("several lists export as one file, one list after another", async () => {
    const a = sheetOf();
    const b = { ...sheetOf(), name: "Second", refNo: "PL0106" };
    const pdf = await getDocumentProxy(await renderPriceSheetsPdf([a, b]));
    assert.ok(pdf.numPages >= 2);
  });
});

describe("rates, CSV and review", () => {
  test("the sheet becomes one rate per SKU, ex-GST derived from what was printed", () => {
    const rates = sheetRates(sheetOf());
    const n20 = rates.find((r) => r.productId === "n20")!;
    assert.equal(n20.rateInclGstPaise, 252_100);
    assert.equal(Math.round(n20.rateExGstPaise / 100), 2136);
    assert.equal(rates.length, 6);
  });

  test("the CSV the export writes is read back into the same cells", () => {
    const sheet = sheetOf();
    const csv = toCsv([...CSV_HEADERS], sheetCsvRows(sheet, new Map(CATALOGUE.map((p) => [p.id, p]))));
    const back = csvToCells(parseCsv(csv), CATALOGUE, "inclusive", 1800);
    assert.equal(back.unmatched.length, 0);
    assert.equal(back.cells.find((c) => c.productId === "n20")?.printedPaise, 252_100);
  });

  test("a spreadsheet naming a product nobody sells is reported, never guessed", () => {
    const back = csvToCells([{ Product: "Mystery Thinner - 1 Liter", "Rate incl GST (Rs)": "100" }], CATALOGUE, "inclusive", 1800);
    assert.equal(back.cells.length, 0);
    assert.equal(back.unmatched.length, 1);
  });

  test("a zero price blocks, an unsigned list only warns", () => {
    const sheet = { ...sheetOf(), signatory: null };
    const priced = Object.values(sheet.rows[0].cells).find((c) => c.productId)!;
    priced.printedPaise = 0;
    const checks = checkSheet(sheet, { todayIso: "2026-07-01" });
    assert.ok(checks.some((c) => c.code === "zero" && c.level === "block"));
    assert.ok(checks.some((c) => c.code === "sign" && c.level === "warn"));
  });
});

describe("a row is what the paper printed", () => {
  // The catalogue files "Astar M126 Thinner" under two brands, one per pack.
  const a = P("a1", "Astar M126 Thinner - 1 Liter (32 Can/Box)", 1000, 32, "32 Can/Box", "Astar M126 Thinner");
  const b = P("b20", "M126 Thinner - 20 Liter (2 Can/Box)", 20000, 2, "2 Can/Box", "M126 Thinner");

  test("a stored list printed as one line comes back as one row, not one per brand", () => {
    const meta = { ...sheetOf(), columns: undefined, rows: undefined } as unknown as Omit<PriceSheet, "columns" | "rows">;
    const sheet = sheetFromRates(meta, [
      { productId: a.id, rateExGstPaise: 10_000, rateInclGstPaise: 11_800, offered: true, minCans: null, rawProductText: "Astar M126 Thinner", product: a },
      { productId: b.id, rateExGstPaise: 180_000, rateInclGstPaise: 212_400, offered: true, minCans: null, rawProductText: "Astar M126 Thinner", product: b },
    ]);
    assert.equal(sheet.rows.length, 1);
    assert.equal(Object.values(sheet.rows[0].cells).filter((c) => c.productId).length, 2);
  });

  test("a spreadsheet row carrying a printed name is kept as one row too", () => {
    const sheet = sheetFromProductCells(
      blankSheet("2026-10-01", 1800),
      [
        { productId: a.id, printedPaise: 11_800, offered: true, printedName: "Astar M126 Thinner" },
        { productId: b.id, printedPaise: 212_400, offered: true, printedName: "Astar M126 Thinner" },
      ],
      [a, b],
    );
    assert.equal(sheet.rows.length, 1);
    assert.equal(sheet.rows[0].label, "Astar M126 Thinner");
  });

  test("with no printed name, rows fall back to the catalogue line", () => {
    const sheet = sheetFromProductCells(
      blankSheet("2026-10-01", 1800),
      [
        { productId: a.id, printedPaise: 11_800, offered: true },
        { productId: b.id, printedPaise: 212_400, offered: true },
      ],
      [a, b],
    );
    assert.equal(sheet.rows.length, 2);
  });
});

describe("the per-litre check", () => {
  test("two boxings of one size are never compared with each other", () => {
    const sheet = sheetOf();
    const col = (cpb: number) => ({ key: `500|can|${cpb}`, millilitres: 500, cansPerBox: cpb, container: "can" as const, ...packLabels(500, "can", cpb) });
    const s = {
      ...sheet,
      columns: [col(50), col(25)],
      rows: [{ key: "r", label: "Line", familyKey: "r", cells: { "500|can|50": { productId: "a", printedPaise: 9_000, offered: true }, "500|can|25": { productId: "b", printedPaise: 12_000, offered: true } } }],
    };
    assert.ok(!checkSheet(s, { todayIso: "2026-01-01" }).some((c) => c.code === "per-litre"));
  });

  test("a bigger pack dearer per litre than a smaller one is flagged", () => {
    const sheet = sheetOf();
    const s = {
      ...sheet,
      columns: [
        { key: "1000|can|32", millilitres: 1000, cansPerBox: 32, container: "can" as const, ...packLabels(1000, "can", 32) },
        { key: "20000|can|2", millilitres: 20000, cansPerBox: 2, container: "can" as const, ...packLabels(20000, "can", 2) },
      ],
      rows: [{ key: "r", label: "Line", familyKey: "r", cells: { "1000|can|32": { productId: "a", printedPaise: 10_000, offered: true }, "20000|can|2": { productId: "b", printedPaise: 400_000, offered: true } } }],
    };
    assert.ok(checkSheet(s, { todayIso: "2026-01-01" }).some((c) => c.code === "per-litre"));
  });
});

describe("terms and copies", () => {
  test("a stored terms block splits back into its clauses, wrapped lines rejoined", () => {
    const clauses = splitTerms("1. First clause\ncontinues here.\n2. Second.");
    assert.deepEqual(clauses, ["First clause continues here.", "Second."]);
  });

  test("a discount clause parses back to the same kind and figure", () => {
    const text = discountClause({ kind: "quantity", percentBp: 250, thresholdLitres: 1000, thresholdPaise: null });
    assert.match(text, /2\.5%/);
    assert.match(text, /1000 litres/);
  });

  test("a copy is named so it can never be mistaken for the list it came from", () => {
    assert.equal(copyName("Odisha", []), "Odisha (copy)");
    assert.equal(copyName("Odisha", ["Odisha (copy)"]), "Odisha (copy 2)");
    assert.equal(copyName("Odisha (copy)", ["Odisha (copy)"]), "Odisha (copy 2)");
  });
});
