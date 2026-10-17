import { test } from "node:test";
import assert from "node:assert/strict";
import { runCalc } from "@/lib/erp/calc";
import { availability, dutyDuration, officeDuration } from "./people";

test("asset availability counts by lot and by name, giving restored quantity back (A36)", () => {
  const stock = [
    { id: "a", name: "Visiting Card", qty: 10 },
    { id: "b", name: "Visiting Card", qty: 5 },
    { id: "c", name: "Laptop", qty: 1 },
  ];
  const assigned = [
    { stockId: "a", qty: 4, restoredQty: null },
    { stockId: "a", qty: 3, restoredQty: 3 },
    { stockId: "c", qty: 2, restoredQty: null },
  ];
  const { lot, byName, inUseByName } = availability(stock, assigned);
  assert.equal(lot.get("a"), 6);
  assert.equal(lot.get("b"), 5);
  assert.equal(byName.get("Visiting Card"), 11);
  assert.equal(inUseByName.get("Visiting Card"), 4);
  assert.equal(lot.get("c"), -1, "over-assignment is allowed and shows below zero (A60)");
});

test("office duration and duty duration", () => {
  assert.equal(officeDuration("09:30", "18:30", "Full Day"), "9h 00m");
  assert.equal(officeDuration("09:30", "18:30", "24 hours"), "24 h");
  assert.equal(officeDuration("18:30", "09:30", "Half Day"), "Closing time must be after opening time");
  assert.equal(dutyDuration("10:00", "14:15"), "4h 15m");
  assert.equal(dutyDuration("", "14:15"), "");
});

test("the assignment form warns when a lot would go below zero", () => {
  const data = { available: { "Laptop · AST-0001 · HQ": { lot: 1, name: 3, asset: "Laptop" } } };
  const ok = runCalc("hrms.asset.available", { h: { stock: "Laptop · AST-0001 · HQ", qty: "1" }, l: {}, lines: [], i: -1, data });
  assert.equal(ok, "1 in this lot · 3 Laptop in stock overall");
  const over = runCalc("hrms.asset.available", { h: { stock: "Laptop · AST-0001 · HQ", qty: "2" }, l: {}, lines: [], i: -1, data });
  assert.match(over, /below zero/);
});
