import { test } from "node:test";
import assert from "node:assert/strict";
import { cashNegative, duplicateExpenses, lrsMissing, rateJumps, readyUnbilled, sfgLosses, thinMargins, writeOffs, type Thresholds } from "./alerts";

const T: Thresholds = {
  rateJumpPct: 20,
  rateLookback: 5,
  rateMissingDays: 3,
  sfgLossPct: 5,
  fillLossPct: 3,
  writeOffCount: 3,
  writeOffDays: 30,
  marginPct: 5,
  fulfilDays: 7,
  readyUnbilledHours: 24,
  stuckTestHours: 48,
  stuckLrDays: 3,
  stuckCnDays: 7,
  stuckPackDays: 3,
  duplicateExpenseDays: 3,
};
const at = (d: string) => new Date(`${d}T10:00:00+05:30`);

test("a rate is compared with the median of the same supplier's earlier rates for the item", () => {
  const base = { item: "Toluene", itemId: "rm", supplier: "AS", supplierId: "s" };
  const c = rateJumps(
    [
      { ...base, id: "p1", date: "2026-01-01", createdAt: at("2026-01-01"), litreRatePaise: 10000 },
      { ...base, id: "p2", date: "2026-02-01", createdAt: at("2026-02-01"), litreRatePaise: 10500 },
      { ...base, id: "p3", date: "2026-03-01", createdAt: at("2026-03-01"), litreRatePaise: 13000 },
      { ...base, id: "p4", date: "2026-03-05", createdAt: at("2026-03-05"), litreRatePaise: 10400, supplierId: "other" },
    ],
    T,
  );
  assert.deepEqual(c.map((x) => x.subject), ["p3"]);
  assert.equal(c[0].power, "viewPurchaseMoney");
  assert.match(c[0].explanation, /above the median ₹102\.5 of its last 2 purchases/);
});

test("losses above their share, write-offs piling up, and thin or negative margins", () => {
  assert.equal(sfgLosses([{ id: "a", sfgNo: 1, product: "NC", totalUse: 100, adjusted: 6 }, { id: "b", sfgNo: 2, product: "NC", totalUse: 100, adjusted: 5 }], T).length, 1);
  const w = writeOffs(
    [
      { id: "t1", date: "2026-09-01", by: "Ravi", fromGodown: "Bhiwandi" },
      { id: "t2", date: "2026-09-10", by: "Ravi", fromGodown: "Ambernath" },
      { id: "t3", date: "2026-09-20", by: "Ravi", fromGodown: "Bhiwandi" },
    ],
    "2026-09-25",
    T,
  );
  assert.deepEqual(w.map((x) => x.subject), ["by:Ravi"]);
  const m = thinMargins(
    [
      { id: "d1", orderNo: 1, party: "P", orderDate: "2026-09-01", dispatchDate: "2026-09-02", amountPaise: 100000, marginPaise: -500 },
      { id: "d2", orderNo: 2, party: "P", orderDate: "2026-09-01", dispatchDate: "2026-09-02", amountPaise: 100000, marginPaise: 20000 },
      { id: "d3", orderNo: 3, party: "P", orderDate: "2026-09-01", dispatchDate: null, amountPaise: 100000, marginPaise: -1 },
    ],
    T,
  );
  assert.deepEqual(m.map((x) => x.subject), ["d1"]);
});

test("stuck work is measured from when it started", () => {
  assert.equal(lrsMissing([{ id: "x", billNo: "B1", party: "P", billDate: "2026-09-20", lr: null }], "2026-09-24", T).length, 1);
  assert.equal(lrsMissing([{ id: "x", billNo: "B1", party: "P", billDate: "2026-09-22", lr: null }], "2026-09-24", T).length, 0);
  const now = at("2026-09-25");
  assert.equal(readyUnbilled([{ id: "o", orderNo: 5, party: "P", readySince: at("2026-09-23"), allocatedInFull: true, billed: false, ready: true }], now, T).length, 1);
  assert.equal(readyUnbilled([{ id: "o", orderNo: 5, party: "P", readySince: at("2026-09-23"), allocatedInFull: false, billed: false, ready: true }], now, T).length, 0);
});

test("petty cash: the same spend twice close together, and a balance below zero", () => {
  const d = duplicateExpenses(
    [
      { id: "e1", by: "Ravi", amountPaise: 50000, particular: "Fuel", date: "2026-09-01" },
      { id: "e2", by: "ravi", amountPaise: 50000, particular: "fuel", date: "2026-09-03" },
      { id: "e3", by: "Ravi", amountPaise: 50000, particular: "Fuel", date: "2026-09-20" },
    ],
    T,
  );
  assert.deepEqual(d.map((x) => x.subject), ["e2"]);
  assert.equal(cashNegative([{ key: "k", employee: "Ravi", godown: "Bhiwandi", mode: "Cash", availablePaise: -100, ids: [] }]).length, 1);
});
