import { test } from "node:test";
import assert from "node:assert/strict";
import { erpUnit, planPackingImport, type PlanInput, type SheetRow } from "./packing-plan";

const BOX_TYPES = ["Empty Box 1 Liter", "Empty Box 5 Liter", "Empty Drum"];
let n = 1;
const row = (cells: Record<string, string>): SheetRow => ({ rowNumber: ++n, cells });
const product = (id: string, canUse: string, boxType = "", boxes = "0", rate = "0") =>
  row({ "Product ID": id, "FG Product Name": `FG ${id}`, "Description Of Goods": `Goods ${id}`, "Can Use": canUse, "Box Type": boxType, "No. Of Empty Box Required": boxes, Rate: rate });
const material = (name: string, type: string, unit = "Pcs") => row({ "Raw Item": name, "Material type": type, "Item Unit": unit, "Item Code": "X", Price: "" });

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    products: [product("1", "Packing Material 1 liter Plain", "Empty Box 1 Liter", "2", "34"), product("3", "Packing Material 1 liter Plain")],
    materials: [material("Packing Material 1 liter Plain", "Can"), material("Empty Box 1 Liter", "Box"), material("Toluene", "Chemical", "Kg")],
    existingMaterials: [],
    skus: [
      { id: "p1", name: "Thinner 1L (2 Can/Box)", externalCode: null, externalIds: [1] },
      { id: "p3", name: "Thinner 1L (Loose)", externalCode: null, externalIds: [3] },
    ],
    packedProductIds: new Set(),
    boxTypes: BOX_TYPES,
    ...over,
  };
}

test("adds the packing materials, never a chemical, and sets each SKU's Can Use", () => {
  const p = planPackingImport(input());
  assert.deepEqual(p.materials.map((m) => [m.name, m.materialType, m.unit]), [
    ["Packing Material 1 liter Plain", "Can", "Unit"],
    ["Empty Box 1 Liter", "Box", "Unit"],
  ]);
  assert.equal(p.materialsNotPacking, 1);
  assert.deepEqual(
    p.packing.map((x) => [x.productId, x.canUse, x.boxType, x.emptyBoxesRequired, x.boxRatePaise]),
    [
      ["p1", "Packing Material 1 liter Plain", "Empty Box 1 Liter", 2, 3400],
      ["p3", "Packing Material 1 liter Plain", null, 0, null],
    ],
  );
});

test("matches on the legacy Product ID, and lists one no SKU carries", () => {
  const p = planPackingImport(input({ products: [product("999", "Packing Material 1 liter Plain")] }));
  assert.equal(p.packing.length, 0);
  assert.equal(p.noSku[0].productIdOnSheet, "999");
});

test("a packing already set in the ERP is left alone", () => {
  const p = planPackingImport(input({ packedProductIds: new Set(["p1"]) }));
  assert.deepEqual(p.packing.map((x) => x.productId), ["p3"]);
  assert.deepEqual(p.kept.map((x) => x.productIdOnSheet), ["1"]);
});

test("an existing material is reused, matched regardless of case and spacing", () => {
  const p = planPackingImport(
    input({
      existingMaterials: [{ id: "m1", name: "packing material  1 LITER plain", materialType: "Can" }],
      products: [product("1", "Packing Material 1 liter Plain")],
    }),
  );
  assert.equal(p.materialsExisting, 1);
  assert.ok(!p.materials.some((m) => m.materialType === "Can"));
  assert.equal(p.packing[0].canUse, "packing material  1 LITER plain");
});

test("a Can Use that is not a Can or Drum is reported, and the boxes still land", () => {
  const p = planPackingImport(input({ products: [product("1", "Empty Box 1 Liter", "Empty Box 1 Liter", "1"), product("3", "Nothing like it")] }));
  assert.deepEqual(p.unknownCan.map((x) => x.canUse), ["Empty Box 1 Liter", "Nothing like it"]);
  assert.equal(p.packing[0].canUse, null);
  assert.equal(p.packing[0].boxType, "Empty Box 1 Liter");
});

test("a Box Type the ERP does not offer is reported; one in different case is read", () => {
  const p = planPackingImport(input({ products: [product("1", "", "empty drum", "1"), product("3", "", "Crate", "1")] }));
  assert.equal(p.packing[0].boxType, "Empty Drum");
  assert.deepEqual(p.unknownBoxType.map((x) => x.boxType), ["Crate"]);
});

test("a second Product ID for one SKU is reported only where its packing differs", () => {
  const skus = [{ id: "p1", name: "Thinner 1L", externalCode: null, externalIds: [1, 2, 4] }];
  const p = planPackingImport(
    input({
      skus,
      products: [product("1", "Packing Material 1 liter Plain"), product("2", "Packing Material 1 liter Plain"), product("4", "", "Empty Drum", "1")],
    }),
  );
  assert.equal(p.packing.length, 1);
  assert.deepEqual(p.conflicting.map((x) => [x.productIdOnSheet, x.keptFrom]), [["4", "1"]]);
});

test("the catalogue's chosen Product ID speaks for its SKU, wherever its row sits", () => {
  const skus = [{ id: "p1", name: "Thinner 1L", externalCode: "4", externalIds: [1, 4] }];
  const p = planPackingImport(input({ skus, products: [product("1", "Packing Material 1 liter Plain"), product("4", "", "Empty Drum", "1")] }));
  assert.equal(p.packing[0].productIdOnSheet, "4");
  assert.deepEqual(p.conflicting.map((x) => [x.productIdOnSheet, x.keptFrom]), [["1", "4"]]);
});

test("units: Pcs is a count", () => {
  assert.equal(erpUnit("Pcs"), "Unit");
  assert.equal(erpUnit("Kg"), "Kg");
  assert.equal(erpUnit("Litre"), "Litre");
});
