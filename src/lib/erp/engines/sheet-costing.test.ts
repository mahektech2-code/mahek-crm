import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSheetCosting, sheetRupeesToPaise, type SheetCostRow } from "./sheet-costing";

test("a sheet cost reads as paise, and anything that is not a cost reads as none", () => {
  assert.equal(sheetRupeesToPaise("16880"), 1688000);
  assert.equal(sheetRupeesToPaise("8,986.5"), 898650);
  assert.equal(sheetRupeesToPaise("₹ 1,110"), 111000);
  assert.equal(sheetRupeesToPaise("0"), null);
  assert.equal(sheetRupeesToPaise("-12"), null);
  assert.equal(sheetRupeesToPaise("#N/A"), null);
  assert.equal(sheetRupeesToPaise(""), null);
  assert.equal(sheetRupeesToPaise(null), null);
});

const row = (orderNo: number, productId: string | null, cans: number, cost: string): SheetCostRow => ({ orderNo, productId, cans, cost });

test("a line takes the cost of the one sheet row with its order, product and cans", () => {
  const m = matchSheetCosting(
    [
      { id: "a", orderNo: 9918, productId: "p1", cans: 10 },
      { id: "b", orderNo: 9918, productId: "p2", cans: 4 },
    ],
    [row(9918, "p1", 10, "16880"), row(9918, "p2", 4, "6400.8"), row(9918, "p1", 12, "999")],
  );
  assert.deepEqual([...m.costs], [["a", 1688000], ["b", 640080]]);
  assert.deepEqual(m.ambiguous, []);
  assert.deepEqual(m.unmatched, []);
});

test("the same line typed twice is one cost; two different costs are left alone", () => {
  const m = matchSheetCosting(
    [
      { id: "twice", orderNo: 1, productId: "p", cans: 2 },
      { id: "torn", orderNo: 2, productId: "p", cans: 2 },
    ],
    [row(1, "p", 2, "500"), row(1, "p", 2, "500.00"), row(2, "p", 2, "500"), row(2, "p", 2, "650")],
  );
  assert.equal(m.costs.get("twice"), 50000);
  assert.equal(m.costs.has("torn"), false);
  assert.deepEqual(m.ambiguous, ["torn"]);
});

test("changed cans, an unresolved product or no cost on the sheet match nothing", () => {
  const m = matchSheetCosting(
    [
      { id: "cans", orderNo: 1, productId: "p", cans: 3 },
      { id: "name", orderNo: 2, productId: "p", cans: 1 },
      { id: "zero", orderNo: 3, productId: "p", cans: 1 },
    ],
    [row(1, "p", 2, "500"), row(2, null, 1, "500"), row(3, "p", 1, "0")],
  );
  assert.equal(m.costs.size, 0);
  assert.deepEqual(m.unmatched, ["cans", "name", "zero"]);
});
