import test from "node:test";
import assert from "node:assert/strict";
import {
  AGE_BUCKETS,
  allocationRefusal,
  fifoPick,
  nextDrumSeq,
  outstanding,
  ownershipOf,
  paymentState,
  receivableBucket,
  returnBucket,
  saleAmount,
  statusOnEmpty,
  suggestAllocation,
  tareVariance,
  varianceIsHigh,
  weightRefusal,
} from "./drums";

/* Empty drums, scrap sale and vendor-returnable drums — the PRD's tests that are rules. */

test("ownership comes from the GRN line, then the supplier, and is never guessed", () => {
  assert.equal(ownershipOf("returnable", "mahek"), "returnable");
  assert.equal(ownershipOf(null, "mahek"), "mahek");
  assert.equal(ownershipOf(null, null), null);
  assert.equal(statusOnEmpty("mahek"), "available");
  assert.equal(statusOnEmpty("returnable"), "returnable");
  assert.equal(statusOnEmpty(null), "review");
});

test("Test 8 — declared 8.00 kg, actual 10.00 kg is +2.00 kg", () => {
  const v = tareVariance(10, 8);
  assert.deepEqual(v, { kg: 2, pct: 25 });
  assert.equal(varianceIsHigh(v, { alertKg: 1.5, alertPercent: 50 }), true);
  assert.equal(varianceIsHigh(tareVariance(8.5, 8), { alertKg: 1.5, alertPercent: 15 }), false);
  /* No declared tare on the GRN: no figure is invented. */
  assert.equal(tareVariance(10, null), null);
  assert.equal(varianceIsHigh(null, { alertKg: 0, alertPercent: 0 }), false);
});

test("a weight that is missing or outside the limits is not saved", () => {
  const l = { minKg: 2, maxKg: 40 };
  assert.match(weightRefusal(null, l)!, /Enter/);
  assert.match(weightRefusal(0, l)!, /more than 0/);
  assert.match(weightRefusal(1, l)!, /below/);
  assert.match(weightRefusal(55, l)!, /above/);
  assert.equal(weightRefusal(10, l), null);
});

test("Test 2 — a lot's drums are registered once each", () => {
  assert.equal(nextDrumSeq(4, []), 1);
  assert.equal(nextDrumSeq(4, [1, 2]), 3);
  assert.equal(nextDrumSeq(4, [1, 3]), 2);
  assert.equal(nextDrumSeq(4, [1, 2, 3, 4]), null);
  /* No drum count on the GRN: the next number, sent for review by the caller. */
  assert.equal(nextDrumSeq(null, [1, 2]), 3);
});

test("Test 4 — 53 eligible drums, sell 20: the 20 oldest go, 33 stay", () => {
  const pool = Array.from({ length: 53 }, (_, i) => ({ id: `d${i}`, drumNo: 100 - i, recordedAt: new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString() }));
  const r = fifoPick(pool, 20);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.picked.map((d) => d.id), pool.slice(0, 20).map((d) => d.id));
  assert.equal(pool.length - r.picked.length, 33);
  const over = fifoPick(pool, 54);
  assert.equal(over.ok, false);
  assert.equal(fifoPick(pool, 0).ok, false);
  assert.equal(fifoPick(pool, 1.5).ok, false);
});

test("FIFO breaks a tie on the drum number", () => {
  const at = "2026-09-01T10:00:00Z";
  const r = fifoPick([{ id: "b", drumNo: 9, recordedAt: at }, { id: "a", drumNo: 3, recordedAt: at }], 1);
  assert.ok(r.ok && r.picked[0].id === "a");
});

test("Tests 9 and 10 — ₹10,000 sale, ₹6,000 then ₹4,000", () => {
  assert.equal(saleAmount(20, 50_000), 1_000_000);
  assert.equal(outstanding(1_000_000, 600_000), 400_000);
  assert.equal(paymentState(1_000_000, 0), "Unpaid");
  assert.equal(paymentState(1_000_000, 600_000), "Partially Paid");
  assert.equal(outstanding(1_000_000, 1_000_000), 0);
  assert.equal(paymentState(1_000_000, 1_000_000), "Paid");
});

test("an allocation never exceeds the receipt left or the sale owed", () => {
  assert.equal(allocationRefusal(600_000, 600_000, 1_000_000), null);
  assert.match(allocationRefusal(700_000, 600_000, 1_000_000)!, /not yet matched/);
  assert.match(allocationRefusal(500_000, 600_000, 400_000)!, /outstanding/);
  assert.match(allocationRefusal(0, 1, 1)!, /above/);
});

test("a receipt is suggested against the oldest due sale first", () => {
  const s = suggestAllocation(700_000, [
    { id: "new", due: "2026-10-05", outstandingPaise: 500_000 },
    { id: "old", due: "2026-09-01", outstandingPaise: 400_000 },
  ]);
  assert.deepEqual(s, [
    { saleId: "old", amountPaise: 400_000 },
    { saleId: "new", amountPaise: 300_000 },
  ]);
});

test("receivable ageing buckets are the PRD's", () => {
  const t = "2026-10-11";
  assert.equal(receivableBucket("2026-10-11", "2026-10-01", t), "Current");
  assert.equal(receivableBucket("2026-10-04", "2026-10-01", t), "1–7");
  assert.equal(receivableBucket("2026-09-26", "2026-09-26", t), "8–15");
  assert.equal(receivableBucket(null, "2026-09-20", t), "16–30");
  assert.equal(receivableBucket(null, "2026-08-20", t), "31–60");
  assert.equal(receivableBucket(null, "2026-01-01", t), "60+");
  assert.equal(AGE_BUCKETS.length, 6);
  assert.equal(returnBucket("2026-10-01", t), "0–30 days");
  assert.equal(returnBucket("2026-06-01", t), "90+ days");
});
