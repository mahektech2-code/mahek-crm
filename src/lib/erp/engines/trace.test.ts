import { test } from "node:test";
import assert from "node:assert/strict";
import { boxLots, looksLikeUnitId, manualMove, normaliseCode, packLabel, qcRefusal, scanGate, scanVerdict, unitId, type ScanLine, type ScanUnit } from "./trace";

test("a unit id is the kind, the day and a six-digit serial", () => {
  assert.equal(unitId("box", "2026-10-08", 125), "BX-261008-000125");
  assert.equal(unitId("loose", "2026-10-08", 7), "LU-261008-000007");
  assert.ok(looksLikeUnitId("BX-261008-000125"));
  assert.ok(!looksLikeUnitId("FP12NA"));
});

test("a scanned code is cleaned of case, whitespace and a link around it", () => {
  assert.equal(normaliseCode("  bx-261008-000125\n"), "BX-261008-000125");
  assert.equal(normaliseCode("https://one.mahekindia.com/erp/trace?q=x/BX-261008-000125"), "BX-261008-000125");
  assert.equal(normaliseCode("https://one.mahekindia.com/u/BX-261008-000125?src=qr"), "BX-261008-000125");
});

test("boxes are filled in the order the batch drew its cans, and a boundary box names both lots", () => {
  const lines = [
    { lot: "FG1NA", cans: 30 },
    { lot: "FG2NA", cans: 30 },
  ];
  assert.deepEqual(boxLots(1, 20, lines), [{ lot: "FG1NA", cans: 20 }]);
  assert.deepEqual(boxLots(2, 20, lines), [
    { lot: "FG1NA", cans: 10 },
    { lot: "FG2NA", cans: 10 },
  ]);
  assert.deepEqual(boxLots(3, 20, lines), [{ lot: "FG2NA", cans: 20 }]);
});

test("only the hand moves a person may make are offered", () => {
  assert.equal(manualMove("available", "hold"), null);
  assert.ok(manualMove("dispatched", "hold"));
  assert.equal(manualMove("hold", "available"), null);
  assert.equal(manualMove("dispatched", "returned"), null);
  assert.ok(manualMove("available", "returned"));
  assert.ok(manualMove("scanned", "rejected"));
});

const unit = (over: Partial<ScanUnit> = {}): ScanUnit => ({
  id: "BX-261008-000125",
  status: "available",
  skuId: "nano1l",
  skuName: "Nano Thinner - 1 Liter (20 Can/Box)",
  productId: "nano",
  productName: "Nano Thinner",
  packLabel: "1 L",
  lotFrom: "pack",
  lotCode: "FP10NA",
  godownId: "g1",
  godownName: "Nagpur",
  orderId: null,
  orderNo: null,
  ...over,
});

const line = (over: Partial<ScanLine> = {}): ScanLine => ({
  id: "o1",
  orderNo: 125,
  skuId: "nano1l",
  skuName: "Nano Thinner - 1 Liter (20 Can/Box)",
  productId: "nano",
  productName: "Nano Thinner",
  packLabel: "1 L",
  godownId: "g1",
  godownName: "Nagpur",
  boxed: true,
  target: 5,
  scanned: 0,
  alloc: [{ id: "bc1", lotCode: "FP10NA", qty: 5, scanned: 0 }],
  dispatched: false,
  cancelled: false,
  ...over,
});

test("a box of the allocated lot is matched", () => {
  const v = scanVerdict(unit(), [line()]);
  assert.ok(v.ok);
  assert.equal(v.ok && v.allocation, "matched");
});

test("an unknown code, a dispatched box and a second scan are refused, and say which", () => {
  assert.equal(scanVerdict(null, [line()]).ok, false);
  const d = scanVerdict(unit({ status: "dispatched", orderNo: 99 }), [line()]);
  assert.ok(!d.ok && d.result === "duplicate" && d.message.includes("99"));
  const again = scanVerdict(unit({ status: "scanned", orderNo: 125 }), [line()]);
  assert.ok(!again.ok && again.result === "duplicate");
  const other = scanVerdict(unit({ status: "scanned", orderNo: 7 }), [line()]);
  assert.ok(!other.ok && other.result === "blocked");
  const hold = scanVerdict(unit({ status: "hold" }), [line()]);
  assert.ok(!hold.ok && hold.result === "blocked");
});

test("the wrong pack size of the right product is a SIZE mismatch, a different product a PRODUCT one", () => {
  const half = unit({ skuId: "nano500", skuName: "Nano Thinner - 500 ml", packLabel: "500 ml" });
  const v = scanVerdict(half, [line()]);
  assert.ok(!v.ok && v.result === "mismatch" && v.mismatch?.kind === "size");
  assert.match(v.ok ? "" : v.message, /Ordered: Nano Thinner – 1 L\. Scanned: Nano Thinner – 500 ml/);
  const pu = unit({ skuId: "pu1l", productId: "pu", productName: "PU Thinner", skuName: "PU Thinner - 1 L" });
  const w = scanVerdict(pu, [line()]);
  assert.ok(!w.ok && w.mismatch?.kind === "product");
});

test("an approved override lets the mismatched unit stand in for its line", () => {
  const half = unit({ skuId: "nano500", skuName: "Nano Thinner - 500 ml", packLabel: "500 ml" });
  const v = scanVerdict(half, [line()], { lineId: "o1" });
  assert.ok(v.ok && v.substituted);
});

test("a full line refuses a further box, and the wrong godown is refused", () => {
  const full = scanVerdict(unit(), [line({ scanned: 5, alloc: [{ id: "bc1", lotCode: "FP10NA", qty: 5, scanned: 5 }] })]);
  assert.ok(!full.ok && full.result === "blocked");
  const away = scanVerdict(unit({ godownId: "g2", godownName: "Raipur" }), [line()]);
  assert.ok(!away.ok && away.message.includes("Raipur"));
});

test("a box of another lot swaps the allocation when the line is fully allocated, and takes one when it is short", () => {
  const swap = scanVerdict(unit({ lotCode: "FP11NA" }), [line()]);
  assert.ok(swap.ok && swap.allocation === "swap" && swap.swapFromId === "bc1");
  const short = scanVerdict(unit({ lotCode: "FP11NA" }), [line({ alloc: [{ id: "bc1", lotCode: "FP10NA", qty: 2, scanned: 2 }], scanned: 2 })]);
  assert.ok(short.ok && short.allocation === "allocate");
});

test("a loose unit never stands in for a box", () => {
  const v = scanVerdict(unit({ lotFrom: "fg" }), [line()]);
  assert.ok(!v.ok);
});

test("scanning gates dispatch only where the lots carry units", () => {
  assert.equal(scanGate({ requireScan: true, lotsHaveUnits: false, target: 5, scanned: 0 }), null);
  assert.equal(scanGate({ requireScan: true, lotsHaveUnits: true, target: 5, scanned: 2 }), "3 of 5 still to scan");
  assert.equal(scanGate({ requireScan: true, lotsHaveUnits: true, target: 5, scanned: 5 }), null);
  assert.equal(scanGate({ requireScan: false, lotsHaveUnits: true, target: 5, scanned: 0 }), null);
});

test("only an Approved SFG lot may be filled; no QC row is Pending", () => {
  assert.equal(qcRefusal("Approved", "12A"), null);
  assert.match(qcRefusal(null, "12A") ?? "", /waiting/);
  assert.match(qcRefusal("Rejected", "12A") ?? "", /rejected/);
});

test("a pack size reads as people say it", () => {
  assert.equal(packLabel(1), "1 L");
  assert.equal(packLabel(0.5), "500 ml");
  assert.equal(packLabel(20), "20 L");
});
