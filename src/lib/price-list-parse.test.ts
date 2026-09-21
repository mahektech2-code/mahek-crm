import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  filenameHints,
  parseLongDate,
  parsePackColumn,
  parsePriceListText,
  parseRupees,
} from "./price-list-parse";
import { matchGrid, type AliasRow, type CatalogueSku } from "./price-list-match";

/* The four real lists, extracted with the same reader the upload path uses.
 * Pages are joined by a form feed, which is how the service hands them over. */
function fixture(name: string) {
  const text = fs.readFileSync(path.join(process.cwd(), "src/lib/fixtures/price-lists", name), "utf8");
  return parsePriceListText(text.split("\f"));
}

const MP_CG = fixture("mp-cg-august-2026.txt");
const ODISHA_PAID = fixture("odisha-paid-august-2026.txt");
const ODISHA_TO_PAY = fixture("odisha-to-pay-august-2026.txt");
const SM = fixture("sm-distributor-august-2026.txt");

/** The cell at one product row and one pack column, by the words they print. */
function cell(list: ReturnType<typeof fixture>, product: string, column: string): number | null {
  const row = list.rows.find((r) => r.rawProduct === product);
  assert.ok(row, `no row named ${product}`);
  const col = list.columns.find((c) => c.label.startsWith(column));
  assert.ok(col, `no column labelled ${column}`);
  return row.cells.find((c) => c.colIndex === col.colIndex)?.inclPaise ?? null;
}

describe("reading a price", () => {
  test("the shapes Mahek prints all come back as paise", () => {
    assert.equal(parseRupees("Rs.1,168"), 116800);
    assert.equal(parseRupees("Rs.1150"), 115000);
    assert.equal(parseRupees("Rs 69"), 6900);
    assert.equal(parseRupees("₹2,286.50"), 228650);
    assert.equal(parseRupees("1,168/-"), 116800);
  });

  test("a dash is an answer and is not a price", () => {
    for (const dash of ["—", "–", "-", "N/A"]) assert.equal(parseRupees(dash), null);
    assert.equal(parseRupees("Ready"), null);
  });
});

describe("reading a pack column", () => {
  test("the size strip and the pack strip are read together", () => {
    assert.deepEqual(parsePackColumn("1 Litre", "32/bx"), {
      label: "1 Litre 32/bx",
      raw: "1 Litre | 32/bx",
      millilitres: 1000,
      cansPerBox: 32,
      container: "can",
    });
    assert.equal(parsePackColumn("500 ml", "50/bx").millilitres, 500);
  });

  test("a tin sold singly is a tin, not a box of one", () => {
    const tin = parsePackColumn("20L Tin Can", "01 Can");
    assert.equal(tin.millilitres, 20000);
    assert.equal(tin.cansPerBox, 1);
    assert.equal(tin.container, "tin");
  });

  test("a drum is one container rather than a box of them", () => {
    assert.equal(parsePackColumn("200 Liter", "Drum").container, "drum");
    assert.equal(parsePackColumn("200 Liter", "Drum").cansPerBox, 1);
  });
});

describe("a date somebody typed", () => {
  test("every spelling the header uses lands on the same day", () => {
    for (const raw of ["01 August 2026", "1st Aug 2026", "August 1, 2026", "01/08/2026", "2026-08-01"]) {
      assert.equal(parseLongDate(raw), "2026-08-01", raw);
    }
  });
});

describe("the four lists Mahek actually issued", () => {
  test("each is read as a grid with nothing left over", () => {
    for (const [name, list] of [["MP & CG", MP_CG], ["Odisha Paid", ODISHA_PAID], ["Odisha To Pay", ODISHA_TO_PAY], ["S M", SM]] as const) {
      assert.equal(list.layout, "grid", name);
      assert.equal(list.confidence, 100, `${name} confidence`);
      assert.ok(list.rows.length >= 5, `${name} rows`);
      for (const row of list.rows) assert.equal(row.cells.length, list.columns.length, `${name} ${row.rawProduct}`);
    }
  });

  test("the header of each says what it is", () => {
    assert.deepEqual(
      { ...MP_CG.header, discountTerms: undefined, termsText: undefined },
      {
        refNo: "PL0105",
        effectiveFrom: "2026-08-01",
        taxBasis: "inclusive",
        gstBp: 1800,
        deliveryBasis: "for_mumbai",
        freightTerm: "to_pay",
        validityDays: 30,
        signatory: "Heena Doshi",
        discountTerms: undefined,
        termsText: undefined,
      },
    );
    assert.equal(ODISHA_PAID.header.refNo, "PL102");
    assert.equal(ODISHA_PAID.header.deliveryBasis, "for_godown");
    assert.equal(ODISHA_PAID.header.freightTerm, "paid");
    assert.equal(ODISHA_TO_PAY.header.refNo, "PL103");
    assert.equal(ODISHA_TO_PAY.header.freightTerm, "to_pay");
    assert.equal(SM.header.refNo, "0106");
  });

  test("Nano Thinner in twenty litres is read exactly as printed, on all four", () => {
    assert.equal(cell(MP_CG, "Maruti Nano Thinner", "20 Litre"), 228_600);
    assert.equal(cell(ODISHA_TO_PAY, "Maruti Nano Thinner", "20 Litre"), 228_100);
    assert.equal(cell(ODISHA_PAID, "Maruti Nano Thinner", "20 Litre"), 252_100);
    assert.equal(cell(SM, "Maruti Nano Thinner", "20 Litre"), 210_000);
  });

  test("a price printed without its comma is still a price", () => {
    // "Rs.1150" on the Odisha To Pay list, where every neighbour has a comma.
    assert.equal(cell(ODISHA_TO_PAY, "Maruti Nano Thinner", "10 Litre"), 115_000);
  });

  test("a dash is carried as not offered rather than as zero", () => {
    const row = MP_CG.rows.find((r) => r.rawProduct === "Mahek N.C. Thinner")!;
    const half = row.cells[0];
    assert.equal(half.inclPaise, null);
    assert.equal(half.offered, false);
    assert.equal(row.cells[1].offered, true);
  });

  test("the Odisha pair carry the tin can column the Mumbai lists do not", () => {
    assert.equal(MP_CG.columns.length, 5);
    assert.equal(ODISHA_PAID.columns.length, 6);
    const tin = ODISHA_PAID.columns[5];
    assert.equal(tin.container, "tin");
    assert.equal(tin.millilitres, 20000);
    assert.equal(cell(ODISHA_PAID, "Maruti Nano Thinner", "20L Tin Can"), 272_100);
  });

  test("only the MP & CG list states a discount, and both of its terms are read", () => {
    assert.deepEqual(
      MP_CG.discountTerms.map((t) => ({ kind: t.kind, percentBp: t.percentBp, thresholdLitres: t.thresholdLitres })),
      [
        { kind: "advance_payment", percentBp: 300, thresholdLitres: null },
        { kind: "quantity", percentBp: 200, thresholdLitres: 1000 },
      ],
    );
    assert.deepEqual(ODISHA_PAID.discountTerms, []);
    assert.deepEqual(SM.discountTerms, []);
  });

  test("the GST sentence in the terms is not read as a discount", () => {
    assert.ok(MP_CG.termsText?.includes("GST @ 18%"));
    assert.ok(!MP_CG.discountTerms.some((t) => t.percentBp === 1800));
  });

  test("a supersedes date left over from an earlier month is warned about, not obeyed", () => {
    assert.equal(ODISHA_PAID.header.effectiveFrom, "2026-08-01");
    assert.ok(ODISHA_PAID.warnings.some((w) => w.includes("2026-04-01")));
    assert.deepEqual(MP_CG.warnings, []);
  });
});

describe("what the filename proposes", () => {
  test("the region, the freight term and the month are read where they are there", () => {
    assert.deepEqual(filenameHints("Mahek_Marketing_India_Price_List_Odisha_To Pay_August2026.pdf"), {
      region: "Odisha",
      freightTerm: "to_pay",
      monthIso: "2026-08",
      customer: null,
      tokens: ["Odisha"],
    });
    assert.equal(filenameHints("Mahek_Marketing_India_Price_List_Odisha_Paid_August2026 1.pdf").freightTerm, "paid");
  });

  test("a region that is not a state is still a region", () => {
    const h = filenameHints("Mahek_Marketing_India_Price_List_MP & CG_August2026 2.pdf");
    assert.equal(h.region, "MP & CG");
    assert.equal(h.customer, null);
  });

  test("a name that is nobody's state is read as a customer", () => {
    const h = filenameHints("Marketing_India_Price_List_S M Distributor_August2026.pdf");
    assert.equal(h.customer, "S M Distributor");
    assert.equal(h.region, null);
    assert.equal(h.monthIso, "2026-08");
  });
});

/* ------------------------------------------------------------- matching */

const CATALOGUE: CatalogueSku[] = [
  sku("p_nano_20_2", "Nano Thinner - 20 Liter (2 Can/Box)", 20000, 2, "2 Can/Box", "Nano Thinner"),
  sku("p_nano_20_loose", "Nano Thinner - 20 Liter (Loose)", 20000, 1, "Loose", "Nano Thinner", false),
  sku("p_nano_tin_20", "Nano Thinner Tin Can - 20 Liter (Loose)", 20000, 1, "Loose", "Nano Thinner Tin Can"),
  sku("p_nano_5_6", "Nano Thinner - 5 Liter (6 Can/Box)", 5000, 6, "6 Can/Box", "Nano Thinner"),
  sku("p_astar_20_2", "Astar Nano Thinner - 20 Liter (2 Can/Box)", 20000, 2, "2 Can/Box", "Astar Nano Thinner"),
  sku("p_nc_5_6", "Mahek N C Thinner - 5 Liter (06 Can/Box)", 5000, 6, "06 Can/Box", "Mahek N C Thinner"),
  sku("p_melody_nc_5_6", "Melody N C Thinner - 5 Liter (6 Can/Box)", 5000, 6, "6 Can/Box", "Melody N C Thinner"),
  sku("p_mylac_1_32", "Mylac Thinner - 1 Liter (32 Can/Box)", 1000, 32, "32 Can/Box", "Mylac Thinner"),
  sku("p_stoving_1_32", "Mahek Stoving Thinner - 1 Liter (32 Can/Box)", 1000, 32, "32 Can/Box", "Mahek Stoving Thinner"),
  sku("p_retarder_1_32", "Mahek Retarder Thinner - 1 Liter (32 Can/Box)", 1000, 32, "32 Can/Box", "Mahek Retarder Thinner"),
  sku("p_sd_1_32", "Mahek Epoxy Thinner (SD) - 1 Liter (32 Can/Box)", 1000, 32, "32 Can/Box", "Epoxy Thinner (SD)"),
  sku("p_fd_1_32", "Mahek Epoxy Thinner (FD) - 1 Liter (32 Can/Box)", 1000, 32, "32 Can/Box", "Epoxy Thinner (FD)"),
  sku("p_m16_tin_1_12", "PU Thinner M16 Tin Can - 1 Liter (12 Can/Box)", 1000, 12, "12 Can/Box", "PU Thinner M16 Tin Can"),
  sku("p_m16_tin_1_24", "PU Thinner M16 Tin Can - 1 Liter (24 Can/Box)", 1000, 24, "24 Can/Box", "PU Thinner M16 Tin Can"),
  sku("p_m1433_1_32", "M1433 Thinner - 1 Liter (32 Can/Box)", 1000, 32, "32 Can/Box", "M1433 Thinner"),
  sku("p_universal_1_32", "Mahek Universal Thinner - 1 Liter (32 Can/Box)", 1000, 32, "32 Can/Box", "Mahek Universal Thinner"),
];

function sku(
  id: string,
  name: string,
  ml: number,
  cansPerBox: number,
  packing: string,
  brandName: string,
  active = true,
): CatalogueSku {
  return { id, name, millilitresPerCan: ml, cansPerBox, packing, brandName, formulationName: null, finishedGoodId: id, active };
}

function match(list: ReturnType<typeof fixture>, product: string, column: string, aliases: AliasRow[] = []) {
  const row = list.rows.find((r) => r.rawProduct === product)!;
  const col = list.columns.find((c) => c.label.startsWith(column))!;
  return matchGrid(list, CATALOGUE, aliases).get(`${row.rowIndex}:${col.colIndex}`)!;
}

describe("matching a row and a column to a SKU", () => {
  test("the company's own name for a product is dropped, and the brand wins", () => {
    const m = match(MP_CG, "Maruti Nano Thinner", "20 Litre");
    assert.equal(m.status, "matched");
    assert.equal(m.productId, "p_nano_20_2");
  });

  test("a tin can column takes the tin SKU and never the ordinary one", () => {
    const m = match(ODISHA_PAID, "Maruti Nano Thinner", "20L Tin Can");
    assert.equal(m.status, "matched");
    assert.equal(m.productId, "p_nano_tin_20");
  });

  test("Mahek's abbreviations resolve to the catalogue's spelling", () => {
    assert.equal(match(MP_CG, "Mahek N.C. Thinner", "5 Litre").productId, "p_nc_5_6");
    assert.equal(match(MP_CG, "Mylac-135 Melamine Thinner", "1 Litre").productId, "p_mylac_1_32");
    assert.equal(match(ODISHA_PAID, "Stoving Thinner (130 C)", "1 Litre").productId, "p_stoving_1_32");
    assert.equal(match(ODISHA_PAID, "Mahek Retarder", "1 Litre").productId, "p_retarder_1_32");
    assert.equal(match(MP_CG, "Mahek Epoxy Thinner S.D.", "1 Litre").productId, "p_sd_1_32");
    assert.equal(match(SM, "Melody N.C. Thinner", "5 Litre").productId, "p_melody_nc_5_6");
    assert.equal(match(SM, "M1433 Thinner", "1 Litre").productId, "p_m1433_1_32");
  });

  test("S.D. and F.D. are not the same product", () => {
    const m = match(MP_CG, "Mahek Epoxy Thinner S.D.", "1 Litre");
    assert.equal(m.productId, "p_sd_1_32");
    assert.ok(!m.candidates.slice(0, 1).some((c) => c.productId === "p_fd_1_32"));
  });

  test("a pack size the catalogue does not carry is never picked silently", () => {
    // The list prints M16 tin cans by the 32; the catalogue has 12 and 24.
    const m = match(MP_CG, "P.U. Thinner M16 Tin Can", "1 Litre");
    assert.notEqual(m.status, "matched");
    assert.ok(m.candidates.some((c) => c.productId === "p_m16_tin_1_12"));
    assert.ok(m.candidates.some((c) => c.productId === "p_m16_tin_1_24"));
  });

  test("a dash cell is matched too, so it can be stored as not offered", () => {
    const m = match(MP_CG, "Mahek N.C. Thinner", "5 Litre");
    assert.equal(m.productId, "p_nc_5_6");
    const row = MP_CG.rows.find((r) => r.rawProduct === "Mahek N.C. Thinner")!;
    assert.equal(row.cells[0].offered, false);
  });

  test("an alias already learned beats every score", () => {
    const m = match(MP_CG, "Maruti Nano Thinner", "20 Litre", [
      { name: "Maruti Nano Thinner - 20 Litre 02/bx", productId: "p_astar_20_2" },
    ]);
    assert.equal(m.status, "alias");
    assert.equal(m.productId, "p_astar_20_2");
    assert.equal(m.confidence, 100);
  });

  test("a retired SKU is offered as a suggestion rather than matched", () => {
    const loose = MP_CG.columns.length; // no loose column on this list
    assert.equal(loose, 5);
    const m = match(MP_CG, "Maruti Nano Thinner", "5 Litre");
    assert.equal(m.productId, "p_nano_5_6");
    assert.equal(m.status, "matched");
  });
});
