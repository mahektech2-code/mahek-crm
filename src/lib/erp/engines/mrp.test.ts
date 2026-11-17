import test from "node:test";
import assert from "node:assert/strict";
import { mrpCheck, type MrpLine, type MrpStock } from "./mrp";

const stock = (over: Partial<MrpStock> = {}): MrpStock => ({
  packedBoxes: new Map(),
  looseCans: new Map(),
  baseLitres: new Map(),
  batchLitres: new Map(),
  material: new Map(),
  materialName: new Map([["tol", "Toluene"], ["xyl", "Xylene"], ["can20", "Empty can 20 L"]]),
  materialUnit: new Map([["tol", "L"], ["xyl", "L"], ["can20", "pcs"]]),
  recipe: new Map([["nano", new Map([["tol", 44], ["xyl", 24]])]]),
  ...over,
});

const nano20: MrpLine = { lineId: "l1", sku: "Nano Thinner 20 L", skuId: "s1", cans: 6, litresPerCan: 20, boxed: false, cansPerBox: 1, finishedGoodId: "fg1", formulationId: "nano", formulation: "Nano", canMaterialId: "can20", canMaterial: "Empty can 20 L" };

test("what is on the shelf is used first; the rest is made from base", () => {
  const a = mrpCheck([nano20], stock({ looseCans: new Map([["fg1", 2]]), baseLitres: new Map([["nano", 100]]), material: new Map([["can20", 62]]) }));
  assert.equal(a.lines[0].onShelfCans, 2);
  assert.equal(a.lines[0].toMakeCans, 4);
  assert.equal(a.lines[0].toMakeLitres, 80);
  assert.equal(a.bases[0].shortLitres, 0, "100 L in the tank covers 80 L");
  assert.deepEqual(a.short, []);
});

test("base short: the recipe's materials are checked for the batches needed", () => {
  const a = mrpCheck([nano20], stock({ batchLitres: new Map([["nano", 80]]), material: new Map([["tol", 310], ["xyl", 9], ["can20", 62]]) }));
  assert.equal(a.bases[0].shortLitres, 120);
  assert.equal(a.bases[0].batches, 2);
  const xyl = a.bases[0].materials.find((m) => m.id === "xyl")!;
  assert.equal(xyl.need, 48);
  assert.equal(xyl.short, 39);
  assert.ok(a.short.some((s) => s.startsWith("Xylene short")));
});

test("a batch size nobody recorded is one batch, and said so", () => {
  const a = mrpCheck([nano20], stock({ material: new Map([["tol", 999], ["xyl", 999], ["can20", 99]]) }));
  assert.equal(a.bases[0].batches, 1);
  assert.equal(a.bases[0].batchGuessed, true);
});

test("empty cans are needed only for what is filled now", () => {
  const a = mrpCheck([nano20], stock({ looseCans: new Map([["fg1", 4]]), baseLitres: new Map([["nano", 999]]), material: new Map([["can20", 1]]) }));
  assert.equal(a.cans[0].need, 2);
  assert.ok(a.short.some((s) => s.startsWith("Empty can 20 L short by 1")));
});

test("packed boxes count first, and two lines of one SKU do not both claim them", () => {
  const boxed: MrpLine = { ...nano20, lineId: "b1", sku: "PU Thinner 5 L (6/Box)", skuId: "pu5", cans: 24, litresPerCan: 5, boxed: true, cansPerBox: 6, finishedGoodId: "fgpu", formulationId: "pu", formulation: "PU", canMaterialId: null, canMaterial: null };
  const a = mrpCheck([boxed, { ...boxed, lineId: "b2" }], stock({ packedBoxes: new Map([["pu5", 5]]), baseLitres: new Map([["pu", 999]]) }));
  assert.equal(a.lines[0].onShelfCans, 24, "4 boxes");
  assert.equal(a.lines[1].onShelfCans, 6, "the one box left");
  assert.equal(a.lines[1].boxesToPack, 3);
});

test("a product that names no base is said to be unknown, never guessed", () => {
  const a = mrpCheck([{ ...nano20, formulationId: null, formulation: null }], stock());
  assert.deepEqual(a.unknown, ["Nano Thinner 20 L"]);
});
