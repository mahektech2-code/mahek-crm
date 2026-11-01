import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baseText, findUom, fromBase, measureOfBase, toBase, unitsFor, uomProblems, type Uom } from "./uom";
import { qtyUnitBase, resolveField, type FieldSpec } from "../ui";

const U = (name: string, measure: Uom["measure"], perBase: number, builtIn = false, active = true): Uom => ({ id: name, name, measure, perBase, builtIn, active });
const units = [U("Kg", "weight", 1, true), U("Litre", "volume", 1, true), U("Pcs", "count", 1, true), U("Gram", "weight", 0.001), U("Drum (200 L)", "volume", 200), U("Dozen", "count", 12), U("Old can", "volume", 15, false, false)];

test("every word the ERP already writes a base unit in is understood", () => {
  for (const w of ["Kg", "kg"]) assert.equal(measureOfBase(w), "weight");
  for (const w of ["Litre", "Ltr", "L", "litres"]) assert.equal(measureOfBase(w), "volume");
  for (const w of ["Pcs", "Unit", "cans", "Boxes", "drums"]) assert.equal(measureOfBase(w), "count");
  for (const w of ["₹", "%", "days", "km", "", null]) assert.equal(measureOfBase(w), null);
});

test("a figure typed in a unit is handed on in the base", () => {
  assert.equal(toBase(2, 200), 400);
  assert.equal(toBase(250, 0.001), 0.25);
  assert.equal(fromBase(400, 200), 2);
  assert.equal(toBase(0.1 * 3, 1), 0.3);
  assert.equal(baseText("2", 200), "400");
  assert.equal(baseText("", 200), "");
  /* The base keeps exactly what was typed, so "1." does not lose its point. */
  assert.equal(baseText("1.", 1), "1.");
});

test("a box offers its own kind only, the base first, and hides retired units", () => {
  assert.deepEqual(unitsFor(units, "volume").map((u) => u.name), ["Litre", "Drum (200 L)"]);
  assert.deepEqual(unitsFor(units, "volume", "old can").map((u) => u.name), ["Litre", "Old can", "Drum (200 L)"]);
  assert.equal(findUom(units, "  drum (200 l) ")?.perBase, 200);
});

test("a unit needs a new name, a kind and a size above zero", () => {
  assert.deepEqual(uomProblems({ name: "Bag (25 kg)", measure: "weight", perBase: "25" }, units), {});
  assert.ok(uomProblems({ name: "gram", measure: "weight", perBase: "1" }, units).name);
  assert.ok(uomProblems({ name: "ltr", measure: "volume", perBase: "1" }, units).name, "a base word cannot be a second unit");
  assert.ok(uomProblems({ name: "X", measure: "area", perBase: "1" }, units).measure);
  assert.ok(uomProblems({ name: "X", measure: "count", perBase: "0" }, units).perBase);
  assert.ok(uomProblems({ name: "X", measure: "count", perBase: "" }, units).perBase);
});

test("a quantity field finds its base from the label, from a sibling, or from a map", () => {
  const f = (o: Partial<FieldSpec>): FieldSpec => ({ k: "qty", l: "Quantity", t: "num", ...o });
  assert.equal(qtyUnitBase(f({ l: "Quantity per batch (litres)" }), {}), "litres");
  assert.equal(qtyUnitBase(f({ l: "Rate (₹)" }), {}), undefined);
  assert.equal(qtyUnitBase(f({}), {}), undefined);
  assert.equal(qtyUnitBase(f({ qtyUnit: { of: "unit" } }), { unit: "Kg" }), "Kg");
  assert.equal(qtyUnitBase(f({ qtyUnit: { by: ["item"], map: { Toluene: "Litre" } } }), { item: "Toluene" }), "Litre");
  assert.equal(qtyUnitBase(f({ qtyUnit: { by: ["item"], map: {} } }), { item: "?" }), "");
  assert.equal(qtyUnitBase(f({ l: "Weight (kg)", qtyUnit: false }), {}), undefined);
  assert.equal(qtyUnitBase(f({ t: "text", l: "Weight (kg)" }), {}), undefined);
  assert.equal(resolveField(f({ qtyUnit: { base: "cans" } }), {}).ub, "cans");
});

test("the migration seeds the three base units the rules depend on", () => {
  const sql = readFileSync(new URL("../../../../drizzle/0310_erp_units_of_measure.sql", import.meta.url), "utf8");
  for (const [name, measure] of [["Kg", "weight"], ["Litre", "volume"], ["Pcs", "count"]]) assert.match(sql, new RegExp(`'${name}', '${measure}', 1, true`));
});
