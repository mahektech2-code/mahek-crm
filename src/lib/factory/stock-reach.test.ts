import { test } from "node:test";
import assert from "node:assert/strict";
import { reachStages, reaches, stockReach } from "./stock-reach";

test("mixing checks raw chemicals and SFG, nothing else", () => {
  const r = stockReach(false, ["mixing"]);
  assert.deepEqual(reachStages(r), ["rm", "sfg"]);
  assert.ok(reaches(r, "rm", "Chemical"));
  assert.ok(reaches(r, "sfg"));
  assert.ok(!reaches(r, "rm", "Can"));
  assert.ok(!reaches(r, "rm", "Box"));
  assert.ok(!reaches(r, "fg"));
  assert.ok(!reaches(r, "pack"));
});

test("filling checks empty cans and drums, filled cans and packed boxes", () => {
  const r = stockReach(false, ["filling"]);
  assert.deepEqual(reachStages(r), ["rm", "fg", "pack"]);
  assert.ok(reaches(r, "rm", "Can"));
  assert.ok(reaches(r, "rm", "drum"));
  assert.ok(reaches(r, "fg"));
  assert.ok(reaches(r, "pack"));
  assert.ok(!reaches(r, "rm", "Chemical"));
  assert.ok(!reaches(r, "sfg"));
});

test("packing checks empty boxes and stationery only", () => {
  const r = stockReach(false, ["packing"]);
  assert.deepEqual(reachStages(r), ["rm"]);
  assert.ok(reaches(r, "rm", "Box"));
  assert.ok(reaches(r, "rm", "Stationary"));
  assert.ok(!reaches(r, "rm", "Can"));
  assert.ok(!reaches(r, "fg"));
  assert.ok(!reaches(r, "pack"));
});

test("several departments reach the union; the whole floor reaches everything", () => {
  const r = stockReach(false, ["mixing", "packing"]);
  assert.ok(reaches(r, "rm", "Chemical") && reaches(r, "rm", "Box") && reaches(r, "sfg"));
  assert.ok(!reaches(r, "fg"));
  for (const all of [stockReach(true, []), stockReach(false, ["head"])]) {
    assert.deepEqual(reachStages(all), ["rm", "sfg", "fg", "pack"]);
    assert.ok(reaches(all, "rm", "Something new"));
  }
});

test("a raw material of a type no department names, or with no type, is the whole floor's", () => {
  const r = stockReach(false, ["mixing", "filling", "packing", "dispatch", "qc"]);
  assert.ok(!reaches(r, "rm", "Label"));
  assert.ok(!reaches(r, "rm", null));
  assert.deepEqual(reachStages(stockReach(false, [])), []);
});
