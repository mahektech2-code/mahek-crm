/**
 * A mixing material poured from more than one drum: what the sheet still asks
 * for, where "Add another drum" goes, and that Next waits for the sheet.
 *
 *   npm run test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { addRmDrum, mixMade, removeRmDrum, rmPlan, rmTotals, stepCheck } from "./rules";
import type { Draft, FactoryData, Task } from "./types";

const db = {
  rm: { tol: { n: "Toluene" }, mek: { n: "MEK" } },
  lots: {
    T1: { code: "T1", type: "rm", item: "tol", avail: 73 },
    T2: { code: "T2", type: "rm", item: "tol", avail: 500 },
    M1: { code: "M1", type: "rm", item: "mek", avail: 500 },
  },
} as unknown as FactoryData;
const t = { proc: "mixing" } as Task;
const draft = (rm: Draft["rm"]): Draft => ({ team: { owner: null, op: null, helpers: [], ver: null }, down: false, downR: null, downMin: null, batches: 2, rm });

test("a drum short of the sheet asks for another drum, and Next waits", () => {
  const d = draft([{ item: "tol", per: 50, lot: "T1", qty: 73 }, { item: "mek", per: 25, lot: "M1", qty: 50 }]);
  assert.deepEqual(rmTotals(d), [{ item: "tol", need: 100, poured: 73 }, { item: "mek", need: 50, poured: 50 }]);
  assert.equal(stepCheck(db, t, d, "materials"), "Toluene: 27 L more needed — add another drum");
  const p = rmPlan(d, 0);
  assert.deepEqual([p.need, p.rest, p.poured, p.last], [100, 100, 73, true]);
});

test("the second drum goes after the first, owes the rest, and the sheet then matches", () => {
  const d = draft([{ item: "tol", per: 50, lot: "T1", qty: 73 }, { item: "mek", per: 25, lot: "M1", qty: 50 }]);
  d.rm = addRmDrum(d.rm!, 0);
  assert.deepEqual(d.rm.map((r) => r.item + (r.extra ? "+" : "")), ["tol", "tol+", "mek"]);
  assert.equal(rmPlan(d, 1).rest, 27);
  assert.equal(rmPlan(d, 0).last, false);
  assert.equal(stepCheck(db, t, d, "materials"), "Scan the next Toluene drum, or remove it");
  d.rm[1] = { ...d.rm[1], lot: "T2", qty: 27 };
  assert.equal(stepCheck(db, t, d, "materials"), "");
  assert.equal(mixMade(d), 150, "what was made is what was poured");
});

test("more than the sheet is refused too, and only an added drum comes off", () => {
  const d = draft([{ item: "tol", per: 50, lot: "T1", qty: 73 }, { item: "tol", per: 50, lot: "T2", qty: 40, extra: true }, { item: "mek", per: 25, lot: "M1", qty: 50 }]);
  assert.equal(stepCheck(db, t, d, "materials"), "Toluene: 13 L more than the sheet — type less");
  assert.equal(removeRmDrum(d.rm!, 0).length, 3, "the sheet's own line stays");
  assert.equal(removeRmDrum(d.rm!, 1).length, 2);
});

test("the materials page also asks whether the machine stopped", () => {
  const d = draft([{ item: "tol", per: 50, lot: "T2", qty: 100 }, { item: "mek", per: 25, lot: "M1", qty: 50 }]);
  d.down = null;
  assert.equal(stepCheck(db, t, d, "materials"), "Did the machine stop? Choose Yes or No");
});
