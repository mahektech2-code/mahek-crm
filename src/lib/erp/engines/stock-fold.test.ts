import { test } from "node:test";
import assert from "node:assert/strict";
import { foldRmLots, itemRowId, lotRowId, readsByLot, type FoldLot } from "./stock-fold";

const lot = (o: Partial<FoldLot> & Pick<FoldLot, "lotNo">): FoldLot => ({
  rawMaterialId: "rm_tol",
  materialType: "Chemical",
  godownId: "g1",
  stock: 10,
  firstDate: "2026-09-01",
  ratePaise: 100,
  ...o,
});

test("a chemical is read lot by lot, and everything else by its item", () => {
  assert.equal(readsByLot("Chemical"), true);
  for (const t of ["Can", "Box", "Drum", "Stationary", "Something new"]) assert.equal(readsByLot(t), false, t);
});

test("two lots of one chemical stay two rows, under the ids they always had", () => {
  const rows = foldRmLots([lot({ lotNo: "T1" }), lot({ lotNo: "T2" })]);
  assert.deepEqual(rows.map((r) => r.id), ["T1|g1", "T2|g1"]);
  assert.ok(rows.every((r) => r.kind === "lot"));
});

test("a can's lots are one total per godown, oldest lot first, valued at their own rates", () => {
  const can = { rawMaterialId: "rm_can", materialType: "Can" };
  const rows = foldRmLots([
    lot({ lotNo: "T1" }),
    lot({ ...can, lotNo: "C2", firstDate: "2026-10-06", stock: 1200, ratePaise: 3140 }),
    lot({ ...can, lotNo: "C1", firstDate: "2026-09-02", stock: 160, ratePaise: 3050 }),
    lot({ ...can, lotNo: "C3", godownId: "g2", stock: 50, ratePaise: 3000 }),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["T1|g1", itemRowId({ rawMaterialId: "rm_can", godownId: "g1" }), "item|rm_can|g2"]);
  const total = rows[1];
  assert.ok(total.kind === "item");
  assert.deepEqual(total.lots.map((l) => l.lotNo), ["C1", "C2"]);
  assert.equal(total.stock, 1360);
  assert.equal(total.valuePaise, 160 * 3050 + 1200 * 3140);
  assert.equal(total.ratePaise, Math.round((160 * 3050 + 1200 * 3140) / 1360));
});

test("a lot drawn below zero counts against its total, and no rate means no value rather than a part-sum", () => {
  const box = { rawMaterialId: "rm_box", materialType: "Box" };
  const [r] = foldRmLots([lot({ ...box, lotNo: "B1", stock: 30 }), lot({ ...box, lotNo: "B2", stock: -70, ratePaise: null, firstDate: "2026-10-01" })]);
  assert.ok(r.kind === "item");
  assert.equal(r.stock, -40);
  assert.equal(r.valuePaise, null);
  assert.equal(r.ratePaise, null);
  assert.equal(lotRowId(r.lots[1]), "B2|g1");
});
