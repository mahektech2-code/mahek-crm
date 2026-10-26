import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateByLitres, deliveryStatus, needsReconciling, tripCostStatus, type PaymentFacts } from "./transport-cost";

test("₹1,000 over 1,000 L is ₹1 a litre, and 250 L carries ₹250", () => {
  const r = allocateByLitres(100000, [
    { id: "a", litres: 250 },
    { id: "b", litres: 500 },
    { id: "c", litres: 250 },
  ]);
  assert.ok(r.ok);
  assert.equal(r.totalLitres, 1000);
  assert.equal(r.costPerLitrePaise, 100);
  assert.deepEqual(
    r.rows.map((x) => x.amountPaise),
    [25000, 50000, 25000],
  );
});

test("three equal shares of ₹1,000 add up to ₹1,000 exactly", () => {
  const r = allocateByLitres(100000, [
    { id: "b", litres: 100 },
    { id: "a", litres: 100 },
    { id: "c", litres: 100 },
  ]);
  assert.ok(r.ok);
  assert.equal(
    r.rows.reduce((s, x) => s + x.amountPaise, 0),
    100000,
  );
  /* 33333.33 each: the one left-over paisa goes to the lowest id on a full tie. */
  assert.deepEqual(Object.fromEntries(r.rows.map((x) => [x.id, x.amountPaise])), { a: 33334, b: 33333, c: 33333 });
});

test("the left-over paise go to the biggest remainders, then the bigger bill", () => {
  const r = allocateByLitres(1001, [
    { id: "x", litres: 1 },
    { id: "y", litres: 2 },
    { id: "z", litres: 7 },
  ]);
  assert.ok(r.ok);
  assert.equal(
    r.rows.reduce((s, x) => s + x.amountPaise, 0),
    1001,
  );
  assert.deepEqual(
    r.rows.map((x) => x.amountPaise),
    [100, 200, 701],
  );
});

test("litres are shared on two decimals and the split is deterministic", () => {
  const items = [
    { id: "p", litres: 12.345 },
    { id: "q", litres: 7.5 },
  ];
  const a = allocateByLitres(99999, items);
  const b = allocateByLitres(99999, [...items].reverse());
  assert.ok(a.ok && b.ok);
  assert.equal(a.rows.find((r) => r.id === "p")!.litres, 12.35);
  assert.deepEqual(
    Object.fromEntries(a.rows.map((r) => [r.id, r.amountPaise])),
    Object.fromEntries(b.rows.map((r) => [r.id, r.amountPaise])),
  );
});

test("zero, missing or invalid litres are refused, naming the bill", () => {
  for (const bad of [0, null, undefined, Number.NaN, -5, 0.001]) {
    const r = allocateByLitres(5000, [
      { id: "good", litres: 10 },
      { id: "bad", litres: bad as number },
    ]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /bad/);
  }
});

test("no amount, a fractional paisa, no bills and a bill chosen twice are refused", () => {
  assert.equal(allocateByLitres(0, [{ id: "a", litres: 1 }]).ok, false);
  assert.equal(allocateByLitres(-100, [{ id: "a", litres: 1 }]).ok, false);
  assert.equal(allocateByLitres(10.5, [{ id: "a", litres: 1 }]).ok, false);
  assert.equal(allocateByLitres(100, []).ok, false);
  assert.equal(
    allocateByLitres(100, [
      { id: "a", litres: 1 },
      { id: "a", litres: 2 },
    ]).ok,
    false,
  );
});

test("one bill takes the whole amount", () => {
  const r = allocateByLitres(12345, [{ id: "solo", litres: 3.3 }]);
  assert.ok(r.ok);
  assert.equal(r.rows[0].amountPaise, 12345);
});

const pay = (over: Partial<PaymentFacts> = {}): PaymentFacts => ({
  status: "allocated",
  amountPaise: 1000,
  shares: [
    { transportId: "t1", litres: 10, amountPaise: 400, billLitresNow: 10 },
    { transportId: "t2", litres: 15, amountPaise: 600, billLitresNow: 15 },
  ],
  ...over,
});

test("trip cost status: not recorded, recorded, allocation pending, allocated", () => {
  assert.equal(tripCostStatus([], ["t1"]), "Not Recorded");
  assert.equal(tripCostStatus([pay({ status: "reversed" })], ["t1", "t2"]), "Not Recorded");
  assert.equal(tripCostStatus([pay({ status: "recorded", shares: [] })], ["t1"]), "Recorded");
  assert.equal(tripCostStatus([pay()], ["t1", "t2", "t3"]), "Allocation Pending");
  assert.equal(tripCostStatus([pay()], ["t1", "t2"]), "Allocated");
});

test("reconciliation is required when a bill's litres moved or the shares do not add up", () => {
  assert.equal(needsReconciling(pay()), false);
  const moved = pay({ shares: [{ transportId: "t1", litres: 10, amountPaise: 1000, billLitresNow: 12 }] });
  assert.equal(needsReconciling(moved), true);
  assert.equal(tripCostStatus([moved], ["t1"]), "Reconciliation Required");
  assert.equal(needsReconciling(pay({ amountPaise: 1001 })), true);
  assert.equal(needsReconciling(pay({ status: "reversed", amountPaise: 1 })), false);
});

test("delivery status follows the PRD's words", () => {
  const today = "2026-10-26";
  const base = { stage: "Dispatched", issue: null, expectedDeliveryOn: null };
  assert.equal(deliveryStatus({ ...base, phase: "toTransport" }, today), "Logistics Pending");
  assert.equal(deliveryStatus({ ...base, phase: "lrPending", stage: "At transport" }, today), "Logistics Pending");
  assert.equal(deliveryStatus({ ...base, phase: "onRoad", stage: "In Transit" }, today), "In Transit");
  assert.equal(deliveryStatus({ ...base, phase: "onRoad", stage: "Reached Destination Area" }, today), "Delivery Pending Confirmation");
  assert.equal(deliveryStatus({ ...base, phase: "onRoad", stage: "In Transit", expectedDeliveryOn: "2026-10-20" }, today), "Delivery Pending Confirmation");
  assert.equal(deliveryStatus({ ...base, phase: "onRoad", stage: "In Transit", issue: "Refused" }, today), "Exception");
  assert.equal(deliveryStatus({ ...base, phase: "delivered", stage: "Close - Received to Party", issue: "Delayed" }, today), "Delivered");
});
