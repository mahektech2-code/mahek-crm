import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyFlow, payingHabit, predictReceipts, type OpenBill } from "./cash-flow";

test("a habit is the amount-weighted days from bill to money, never negative", () => {
  const h = payingHabit([
    { billDate: "2026-07-01", paidOn: "2026-08-30", amountPaise: 300_000_00 }, // 60 days, big
    { billDate: "2026-07-10", paidOn: "2026-07-20", amountPaise: 2_000_00 }, // 10 days, small
    { billDate: "2026-07-15", paidOn: "2026-07-10", amountPaise: 2_000_00 }, // paid in advance → 0
  ])!;
  assert.equal(h.samples, 3);
  assert.equal(h.avgDays, 59); // the large bill dominates: (60×3,00,000 + 10×2,000) ÷ 3,04,000
  assert.ok(h.spreadDays > 0);
  assert.equal(payingHabit([]), null);
});

const bill = (o: Partial<OpenBill>): OpenBill => ({
  billId: "b1",
  billNo: "MMI/1",
  customerId: "c1",
  customerName: "Colour Camp",
  billDate: "2026-09-20",
  balancePaise: 50_000_00,
  ...o,
});

test("a bill is expected at its date plus the customer's own habit, not its credit term", () => {
  const habits = new Map([["c1", { avgDays: 45, spreadDays: 5, samples: 6 }]]);
  const [p] = predictReceipts({
    bills: [bill({})],
    habits,
    companyHabit: { avgDays: 30, spreadDays: 10, samples: 400 },
    minSamples: 3,
    today: "2026-10-08",
  });
  assert.equal(p.expectedOn, "2026-11-04");
  assert.equal(p.basis, "own");
  assert.equal(p.lateDays, 0);
});

test("too few payments borrow the company's habit, and say so; a gone day is late", () => {
  const habits = new Map([["c1", { avgDays: 5, spreadDays: 0, samples: 1 }]]);
  const [p] = predictReceipts({
    bills: [bill({ billDate: "2026-08-01" })],
    habits,
    companyHabit: { avgDays: 30, spreadDays: 10, samples: 400 },
    minSamples: 3,
    today: "2026-10-08",
  });
  assert.equal(p.basis, "company");
  assert.equal(p.expectedOn, "2026-08-31");
  assert.equal(p.lateDays, 38);
});

test("nothing is predicted for a settled bill, or with no habit anywhere", () => {
  assert.equal(
    predictReceipts({ bills: [bill({ balancePaise: 0 })], habits: new Map(), companyHabit: { avgDays: 30, spreadDays: 0, samples: 9 }, minSamples: 3, today: "2026-10-08" }).length,
    0,
  );
  assert.equal(predictReceipts({ bills: [bill({})], habits: new Map(), companyHabit: null, minSamples: 3, today: "2026-10-08" }).length, 0);
});

test("the daily flow sums each side, runs a net, and folds nothing from before the window", () => {
  const rows = dailyFlow(
    [
      { on: "2026-10-08", amountPaise: 100 },
      { on: "2026-10-09", amountPaise: 50 },
      { on: "2026-10-01", amountPaise: 999 }, // before the window
    ],
    [{ on: "2026-10-09", amountPaise: 120 }],
    "2026-10-08",
    3,
  );
  assert.deepEqual(
    rows.map((r) => [r.date, r.inPaise, r.outPaise, r.netPaise, r.runningPaise]),
    [
      ["2026-10-08", 100, 0, 100, 100],
      ["2026-10-09", 50, 120, -70, 30],
      ["2026-10-10", 0, 0, 0, 30],
    ],
  );
});
