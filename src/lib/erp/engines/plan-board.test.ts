import { test } from "node:test";
import assert from "node:assert/strict";
import { beyondConfirmed, buildBoard, facetValues, type BoardLine } from "./plan-board";
import type { ExpectedPlan, ProductRow } from "./expected-plan";
import type { OrderDemand } from "./production-plan";

const product = (over: Partial<ProductRow>): ProductRow => ({
  key: "loose:fg1",
  category: "loose",
  itemId: "fg1",
  name: "Nano Thinner 20 L",
  size: "20 L",
  code: null,
  packing: "loose",
  cansPerBox: 1,
  confirmed: 0,
  mrp: 0,
  accounts: 0,
  stock: 0,
  verdict: { tone: "ok", text: "Enough · 0 spare", note: null },
  orders: [],
  ...over,
});

const plan = (products: ProductRow[], bases: ExpectedPlan["bases"] = []): ExpectedPlan => ({
  products,
  bases,
  counts: { confirmedOrders: 0, mrpOrders: 0, accountsTos: 0, oldestAccounts: null },
  shortProducts: [],
});

const line = (over: Partial<BoardLine>): BoardLine => ({ id: "l1", category: "loose", itemId: "fg1", source: "order", sourceKey: "loose:fg1", productName: "Nano Thinner 20 L", size: "20 L", quantity: 5, unit: "Cans", remarks: null, ...over });

test("confirmed work starts ticked at what it needs; waiting work starts unticked at the whole", () => {
  const rows = buildBoard(plan([product({ confirmed: 18, mrp: 40, stock: 52, verdict: { tone: "short", text: "", note: null } }), product({ key: "loose:fg2", itemId: "fg2", name: "Astar", accounts: 30 })]), []);
  const nano = rows.find((r) => r.key === "loose:fg1")!;
  assert.deepEqual([nano.ticked, nano.qty, nano.unit, nano.verdict?.text], [true, 18, "Cans", "Short 6"]);
  const astar = rows.find((r) => r.key === "loose:fg2")!;
  assert.deepEqual([astar.ticked, astar.qty], [false, 30]);
});

test("a packing row is counted in boxes where the orders make whole boxes", () => {
  const [r] = buildBoard(plan([product({ key: "packing:s1", category: "packing", itemId: "s1", packing: "6 cans/box", cansPerBox: 6, confirmed: 24, mrp: 12 })]), []);
  assert.deepEqual([r.qty, r.unit, r.units], [4, "Boxes", ["Boxes", "Cans"]]);
  const [odd] = buildBoard(plan([product({ key: "packing:s1", category: "packing", itemId: "s1", cansPerBox: 6, confirmed: 7 })]), []);
  assert.deepEqual([odd.qty, odd.unit], [7, "Cans"]);
});

test("a row already on the plan keeps its line's figure and its tick; a typed line nothing covers is its own row", () => {
  const rows = buildBoard(plan([product({ confirmed: 18 })]), [line({ quantity: 25 }), line({ id: "l2", source: "manual", sourceKey: null, category: "sfg", itemId: "f9", productName: "PU base", size: null, quantity: 100, unit: "Litre" })]);
  const nano = rows.find((r) => r.key === "loose:fg1")!;
  assert.deepEqual([nano.qty, nano.lineId, nano.ticked], [25, "l1", true]);
  const typed = rows.find((r) => r.key === "line:l2")!;
  assert.deepEqual([typed.category, typed.ticked, typed.qty, typed.unit], ["sfg", true, 100, "Litre"]);
  assert.equal(rows[rows.length - 1].key, "line:l2", "bases sort after cans and packing");
});

test("a base row starts at what confirmed work is short of, and a typed base line joins it", () => {
  const rows = buildBoard(plan([], [{ formulationId: "f1", name: "Nano base", confirmedLitres: 160, expectedLitres: 600, inTank: 100, shortLitres: 660, expectedFor: [] }]), [line({ id: "l3", source: "manual", sourceKey: null, category: "sfg", itemId: "f1", quantity: 400, unit: "Litre" })]);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].qty, rows[0].lineId, rows[0].confirmedNeed], [400, "l3", 60]);
  const fresh = buildBoard(plan([], [{ formulationId: "f1", name: "Nano base", confirmedLitres: 160, expectedLitres: 600, inTank: 100, shortLitres: 660, expectedFor: [] }]), [])[0];
  assert.deepEqual([fresh.qty, fresh.ticked], [60, true]);
});

test("beyond confirmed is what prints as not approved yet", () => {
  const [r] = buildBoard(plan([product({ key: "packing:s1", category: "packing", itemId: "s1", cansPerBox: 6, confirmed: 24, mrp: 12 })]), []);
  assert.equal(beyondConfirmed(r, 4, "Boxes"), false);
  assert.equal(beyondConfirmed(r, 5, "Boxes"), true);
  assert.equal(beyondConfirmed(r, 25, "Cans"), true);
  const [plain] = buildBoard(plan([product({ confirmed: 10 })]), []);
  assert.equal(beyondConfirmed(plain, 99, "Cans"), false, "nothing waiting, nothing beyond");
});

test("each column filter reads one value set per row", () => {
  const [r] = buildBoard(plan([product({ confirmed: 0, mrp: 4, accounts: 2, stock: 0 })]), []);
  assert.deepEqual(facetValues(r, "Cans"), { kind: ["Loose cans"], confirmed: ["None confirmed"], waiting: ["MRP check", "Accounts"], stock: ["None in stock"], verdict: ["Enough"], unit: ["Cans"] });
});

const remarked = (orderNo: number, cans: number, over: Partial<OrderDemand> = {}): OrderDemand => ({
  key: `packing:s1:o${orderNo}`,
  productKey: "packing:s1",
  orderNo,
  category: "packing",
  itemId: "s1",
  productName: "M5x4 1 L",
  productCode: null,
  size: "1 L",
  quantity: cans / 32,
  unit: "Boxes",
  orderRefs: String(orderNo),
  remarks: "Customer sticker",
  cans,
  ...over,
});

test("an order with a remark is a row of its own under its product, ticked; stock stays on the product's row", () => {
  const p = product({ key: "packing:s1", category: "packing", itemId: "s1", name: "M5x4 1 L", packing: "32 cans/box", cansPerBox: 32, confirmed: 128, stock: 40, verdict: { tone: "short", text: "", note: null } });
  const rows = buildBoard(plan([p]), [], [remarked(103, 32)]);
  assert.deepEqual(
    rows.map((r) => [r.key, r.confirmed, r.qty, r.unit, r.ticked, r.stock, r.verdict?.text ?? null]),
    [
      ["packing:s1", 96, 3, "Boxes", true, 40, "Short 88"],
      ["packing:s1:o103", 32, 1, "Boxes", true, null, null],
    ],
  );
  /* A remarked row prints its own line, never one somebody typed for the product. */
  const typed = line({ id: "t1", source: "manual", sourceKey: null, category: "packing", itemId: "s1", quantity: 2, unit: "Boxes" });
  const withTyped = buildBoard(plan([p]), [typed, line({ id: "o1", sourceKey: "packing:s1:o103", category: "packing", itemId: "s1", quantity: 1, unit: "Boxes" })], [remarked(103, 32)]);
  assert.deepEqual(withTyped.map((r) => [r.key, r.lineId]), [["packing:s1", "t1"], ["packing:s1:o103", "o1"]]);
});

test("a product whose every order has a remark has no empty row; the first remarked row reads the stock", () => {
  const p = product({ key: "packing:s1", category: "packing", itemId: "s1", name: "M5x4 1 L", cansPerBox: 32, confirmed: 48, stock: 10 });
  const rows = buildBoard(plan([p]), [], [remarked(103, 32), remarked(104, 16, { remarks: "Blue" })]);
  assert.deepEqual(
    rows.map((r) => [r.key, r.qty, r.unit, r.stock]),
    [
      ["packing:s1:o103", 1, "Boxes", 10],
      ["packing:s1:o104", 16, "Cans", null],
    ],
  );
});
