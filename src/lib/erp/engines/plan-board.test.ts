import { test } from "node:test";
import assert from "node:assert/strict";
import { beyondConfirmed, buildBoard, facetValues, type BoardLine } from "./plan-board";
import type { ExpectedPlan, ProductRow } from "./expected-plan";

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
