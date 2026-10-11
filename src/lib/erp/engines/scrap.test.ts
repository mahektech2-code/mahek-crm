import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ageingBucket,
  allocationRefusal,
  daysBetween,
  drumMoveRefusal,
  fifoPick,
  highVariance,
  invoiceRefusal,
  otherScrapBalance,
  outstanding,
  parseDrumCode,
  pickDrumSeq,
  routeDrum,
  saleAmount,
  salePayState,
  spreadOldestFirst,
  tareVariance,
  weightCheck,
} from "./scrap";

test("a label names a lot, and a lot/number names one of its drums", () => {
  assert.deepEqual(parseDrumCode(" ATTOL1228 "), { lot: "ATTOL1228", seq: null });
  assert.deepEqual(parseDrumCode("ATTOL1228/3"), { lot: "ATTOL1228", seq: 3 });
  assert.deepEqual(parseDrumCode("ATTOL1228#12"), { lot: "ATTOL1228", seq: 12 });
  assert.equal(parseDrumCode("ATTOL1228/0"), null);
  assert.equal(parseDrumCode("   "), null);
});

test("ownership routes the drum, and no owner is a question for a person (§3)", () => {
  assert.equal(routeDrum("mahek"), "available");
  assert.equal(routeDrum("vendor"), "returnable");
  assert.equal(routeDrum(null), "review");
});

test("a second scan of the same drum cannot add it again (Test 2)", () => {
  assert.deepEqual(pickDrumSeq(6, [1, 2], null), { seq: 3 });
  assert.deepEqual(pickDrumSeq(6, [1, 2], 2), { refusal: "Drum 2 of this lot is already recorded as empty.", existing: 2 });
  assert.ok("refusal" in pickDrumSeq(2, [1, 2], null));
  assert.ok("refusal" in pickDrumSeq(2, [], 3));
  assert.ok("refusal" in pickDrumSeq(null, [], null));
});

test("variance is actual minus declared (Test 8)", () => {
  assert.deepEqual(tareVariance(10, 8), { kg: 2, pct: 25 });
  assert.equal(tareVariance(10, null), null);
  assert.ok(highVariance({ kg: -2 }, 1.5));
  assert.ok(!highVariance({ kg: 1 }, 1.5));
  assert.ok(!highVariance(null, 1.5));
});

test("a weight outside the limits is refused, a missing one says so", () => {
  assert.deepEqual(weightCheck(9.5, 1, 40), { ok: true });
  const missing = weightCheck(null, 1, 40);
  assert.ok(!missing.ok && missing.missing);
  const heavy = weightCheck(55, 1, 40);
  assert.ok(!heavy.ok && !heavy.missing);
});

test("FIFO takes the oldest emptied drums, and never more than there are (Test 4)", () => {
  const rows = Array.from({ length: 53 }, (_, i) => ({ drumNo: 53 - i, emptiedAt: new Date(Date.UTC(2026, 0, 1 + (52 - i))) }));
  const r = fifoPick(rows, 20);
  assert.ok("picked" in r);
  assert.equal(r.picked.length, 20);
  assert.deepEqual(
    r.picked.map((x) => x.drumNo),
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
  assert.ok("refusal" in fifoPick(rows, 54));
  assert.ok("refusal" in fifoPick(rows, 0));
  assert.ok("refusal" in fifoPick(rows, 1.5));
});

test("a sold or returned drum cannot be moved again", () => {
  assert.ok(drumMoveRefusal("sold", "cancelled"));
  assert.ok(drumMoveRefusal("returned", "correct"));
  assert.ok(drumMoveRefusal("available", "decide"));
  assert.equal(drumMoveRefusal("review", "decide"), null);
  assert.equal(drumMoveRefusal("available", "cancelled"), null);
});

test("partial then final payment (Tests 9 and 10)", () => {
  const amount = saleAmount(20, 50000);
  assert.equal(amount, 1000000);
  assert.equal(outstanding(amount, 600000), 400000);
  assert.equal(salePayState(amount, 600000, false), "Partially paid");
  assert.equal(salePayState(amount, 1000000, false), "Paid");
  assert.equal(outstanding(amount, 1000000), 0);
  assert.equal(salePayState(amount, 0, false), "Unpaid");
  assert.equal(salePayState(amount, 0, true), "Cancelled");
});

test("an allocation never takes more than the receipt has or the sale owes", () => {
  assert.equal(allocationRefusal(400000, 600000, 400000), null);
  assert.ok(allocationRefusal(700000, 600000, 1000000));
  assert.ok(allocationRefusal(500000, 600000, 400000));
  assert.ok(allocationRefusal(0, 600000, 400000));
  assert.deepEqual(spreadOldestFirst(700000, [{ id: "a", owedPaise: 400000 }, { id: "b", owedPaise: 500000 }]), [
    { saleId: "a", amountPaise: 400000 },
    { saleId: "b", amountPaise: 300000 },
  ]);
});

test("a sale without an invoice invents no invoice number (Test 11)", () => {
  assert.equal(invoiceRefusal("none", null), null);
  assert.equal(invoiceRefusal("none", "CH-22"), null);
  assert.ok(invoiceRefusal("invoice", null));
});

test("ageing buckets", () => {
  assert.equal(ageingBucket(0), "Current");
  assert.equal(ageingBucket(7), "1–7");
  assert.equal(ageingBucket(8), "8–15");
  assert.equal(ageingBucket(30), "16–30");
  assert.equal(ageingBucket(61), "60+");
  assert.equal(daysBetween("2026-09-28", "2026-10-03"), 5);
});

test("other scrap balances by category and unit", () => {
  const b = otherScrapBalance(
    [
      { category: "plastic", unit: "Kg", quantity: 40 },
      { category: "plastic", unit: "Kg", quantity: 10.5 },
    ],
    [{ category: "plastic", unit: "Kg", quantity: 20 }],
  );
  assert.equal(b.get("plastic|Kg"), 30.5);
});
