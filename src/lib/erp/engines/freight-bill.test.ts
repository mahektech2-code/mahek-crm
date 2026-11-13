import { test } from "node:test";
import assert from "node:assert/strict";
import { billProblems, editRefusal, freightBillName, lineEligibility, markPaidRefusal, paiseFromRupees, splitBill, staleShares, undoPaymentRefusal } from "./freight-bill";

test("the PRD's own example: ₹1,000 over 500 L is ₹2 a litre, and the shares are the bill", () => {
  const r = splitBill(100000, [
    { orderId: "a", litres: 100 },
    { orderId: "b", litres: 150 },
    { orderId: "c", litres: 250 },
  ]);
  assert.ok(r.ok);
  assert.equal(r.totalLitres, 500);
  assert.equal(r.costPerLitrePaise, 200);
  assert.deepEqual(
    r.rows.map((x) => x.amountPaise),
    [20000, 30000, 50000],
  );
});

test("a rate that does not divide evenly still adds up to the bill to the paisa", () => {
  const r = splitBill(400000, [
    { orderId: "a", litres: 400 },
    { orderId: "b", litres: 360 },
    { orderId: "c", litres: 110 },
    { orderId: "d", litres: 630 },
    { orderId: "e", litres: 370 },
  ]);
  assert.ok(r.ok);
  assert.equal(
    r.rows.reduce((a, x) => a + x.amountPaise, 0),
    400000,
  );
});

test("only Paid freight is a company expense", () => {
  assert.deepEqual(lineEligibility({ freightTerm: "Paid", litres: 10, takenBy: null }), { ok: true });
  assert.equal(lineEligibility({ freightTerm: "To Pay", litres: 10, takenBy: null }).ok, false);
  assert.equal(lineEligibility({ freightTerm: "to-pay", litres: 10, takenBy: null }).ok, false);
  assert.equal(lineEligibility({ freightTerm: "TBB", litres: 10, takenBy: null }).ok, false);
  assert.equal(lineEligibility({ freightTerm: null, litres: 10, takenBy: null }).ok, false);
});

test("a line already on another bill, or with no litres, cannot be ticked", () => {
  const taken = lineEligibility({ freightTerm: "Paid", litres: 10, takenBy: "TB-4 · LR 1" });
  assert.ok(!taken.ok && taken.kind === "taken" && /TB-4/.test(taken.why));
  const none = lineEligibility({ freightTerm: "Paid", litres: 0, takenBy: null });
  assert.ok(!none.ok && none.kind === "no_litres");
});

test("rupees as typed become paise, and nonsense is refused", () => {
  assert.equal(paiseFromRupees("1,000"), 100000);
  assert.equal(paiseFromRupees("₹ 1000.5"), 100050);
  assert.equal(paiseFromRupees("0"), null);
  assert.equal(paiseFromRupees("ten"), null);
  assert.equal(paiseFromRupees("1.234"), null);
});

test("a bill needs its number, date, transporter, vehicle, amount and at least one line", () => {
  const ok = { lrNo: "88213", billDate: "2026-11-02", transporter: "Shree Ganesh", vehicleNo: "MH04", dispatchOn: "2026-11-02", amountPaise: 100000, orderIds: ["a"] };
  assert.deepEqual(billProblems(ok, "2026-11-13"), {});
  const bad = billProblems({ ...ok, lrNo: " ", amountPaise: null, orderIds: [], billDate: "2026-12-01" }, "2026-11-13");
  assert.deepEqual(Object.keys(bad).sort(), ["amount", "billDate", "lrNo", "orderIds"]);
});

test("a split goes stale when a line's litres, freight or dispatch change", () => {
  const stored = [
    { orderId: "a", litres: 120 },
    { orderId: "b", litres: 50 },
    { orderId: "c", litres: 30 },
    { orderId: "d", litres: 10 },
  ];
  const now = new Map([
    ["a", { orderId: "a", litres: 110, freightTerm: "Paid", gone: false }],
    ["b", { orderId: "b", litres: 50, freightTerm: "Paid", gone: false }],
    ["c", { orderId: "c", litres: 30, freightTerm: "To Pay", gone: false }],
  ]);
  const s = staleShares(stored, now);
  assert.deepEqual(
    s.map((x) => [x.orderId, x.why]),
    [
      ["a", "litres"],
      ["c", "not_paid"],
      ["d", "gone"],
    ],
  );
});

test("a paid bill cannot be edited; a stale one cannot be paid; only a manager undoes a payment", () => {
  assert.equal(editRefusal("pending"), null);
  assert.match(editRefusal("paid") ?? "", /Undo the payment/);
  assert.equal(markPaidRefusal("pending", 0), null);
  assert.match(markPaidRefusal("pending", 1) ?? "", /Split it again/);
  assert.match(markPaidRefusal("paid", 0) ?? "", /already paid/);
  assert.match(undoPaymentRefusal("paid", false) ?? "", /manager/);
  assert.equal(undoPaymentRefusal("paid", true), null);
  assert.match(undoPaymentRefusal("pending", true) ?? "", /paid bill/);
});

test("a bill is named by its number and its LR", () => {
  assert.equal(freightBillName(1041, "88213"), "TB-1041 · LR 88213");
});
