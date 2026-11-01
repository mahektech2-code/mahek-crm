import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScanUnit } from "@/lib/erp/engines/trace";
import { applyLocal, judgeLorryScan, orderForUnit, type LoadingPack, type PackLine } from "./lorry-judge";

/* The phone's judgement of a lorry scan — the same decisions `lorryScan` makes, against a pack. */

const G = "gd-1";
const line = (o: Partial<PackLine> & { id: string; orderNo: number; skuId: string }): PackLine => ({
  skuName: o.skuId, productId: "pr-" + o.skuId, productName: "P", packLabel: "20 L", godownId: G, godownName: "Ambernath",
  boxed: true, target: 2, scanned: 0, alloc: [], dispatched: false, cancelled: false, finishedGoodId: null, dispatchOn: null, stickered: false, ...o,
});
const unit = (o: Partial<ScanUnit> & { id: string; skuId: string }): ScanUnit => ({
  status: "available", skuName: o.skuId, productId: "pr-" + o.skuId, productName: "P", packLabel: "20 L", lotFrom: "pack", lotCode: "LOT1",
  godownId: G, godownName: "Ambernath", orderId: null, orderNo: null, ...o,
});
const pack = (o: Partial<LoadingPack>): LoadingPack => ({ key: "L:vrl", godownId: G, at: "2026-11-01T10:00:00.000Z", lines: [], units: [], overrides: [], stickers: [], free: [], ...o });

const B1 = "BX-261101-000001", B2 = "BX-261101-000002", B3 = "BX-261101-000003", BX = "BX-261101-000099";

test("a box of an allocated lot goes on, and the same box again is a repeat", () => {
  let p = pack({
    lines: [line({ id: "l1", orderNo: 10, skuId: "s1", alloc: [{ id: "bc1", lotCode: "LOT1", qty: 2, scanned: 0 }] })],
    units: [unit({ id: B1, skuId: "s1" }), unit({ id: B2, skuId: "s1" })],
  });
  const j = judgeLorryScan(p, B1.toLowerCase(), null);
  assert.equal(j.result, "accepted");
  assert.equal(j.line, "l1");
  assert.equal(j.why, "matched");
  p = applyLocal(p, j);
  assert.equal(p.lines[0].scanned, 1);
  assert.equal(p.lines[0].alloc[0].scanned, 1);
  assert.equal(judgeLorryScan(p, B1, null).result, "repeat");
  p = applyLocal(p, judgeLorryScan(p, B2, null));
  /* Full: a third box of the SKU is refused, not put on. */
  const p3 = { ...p, units: [...p.units, unit({ id: B3, skuId: "s1" })] };
  assert.equal(judgeLorryScan(p3, B3, null).result, "refused");
});

test("wrong stock is refused; a code the pack does not carry is unknown, not refused", () => {
  const p = pack({ lines: [line({ id: "l1", orderNo: 10, skuId: "s1" })], units: [unit({ id: B2, skuId: "s9", productId: "pr-other" })] });
  const wrong = judgeLorryScan(p, B2, null);
  assert.equal(wrong.result, "refused");
  assert.equal(wrong.why, "mismatch");
  assert.equal(judgeLorryScan(p, BX, null).result, "unknown");
  assert.equal(judgeLorryScan(p, "PB-2611-07", null).result, "lot");
  assert.equal(judgeLorryScan(p, "   ", null).result, "refused");
});

test("a box of an unallocated lot needs the lot's stock free, and taking it uses that stock up", () => {
  const lines = [line({ id: "l1", orderNo: 10, skuId: "s1", target: 2 })];
  const units = [unit({ id: B1, skuId: "s1", lotCode: "LOT7" }), unit({ id: B2, skuId: "s1", lotCode: "LOT7" })];
  assert.equal(judgeLorryScan(pack({ lines, units }), B1, null).why, "lot-not-free");
  let p = pack({ lines, units, free: [{ lotFrom: "pack", lotCode: "LOT7", skuId: null, free: 1 }] });
  const j = judgeLorryScan(p, B1, null);
  assert.equal(j.result, "accepted");
  assert.equal(j.why, "allocate");
  p = applyLocal(p, j);
  assert.deepEqual(p.lines[0].alloc.map((a) => [a.lotCode, a.qty, a.scanned]), [["LOT7", 1, 1]]);
  assert.equal(p.free[0].free, 0);
  assert.equal(judgeLorryScan(p, B2, null).why, "lot-not-free");
});

test("a lot swapped in takes one from the line's other lot", () => {
  let p = pack({
    lines: [line({ id: "l1", orderNo: 10, skuId: "s1", target: 1, alloc: [{ id: "bc1", lotCode: "LOT1", qty: 1, scanned: 0 }] })],
    units: [unit({ id: B1, skuId: "s1", lotCode: "LOT2" })],
    free: [{ lotFrom: "pack", lotCode: "LOT2", skuId: null, free: 3 }, { lotFrom: "pack", lotCode: "LOT1", skuId: null, free: 0 }],
  });
  const j = judgeLorryScan(p, B1, null);
  assert.equal(j.why, "swap");
  p = applyLocal(p, j);
  assert.deepEqual(p.lines[0].alloc.map((a) => [a.lotCode, a.qty, a.scanned]), [["LOT2", 1, 1]]);
  assert.deepEqual(p.free.map((f) => f.free), [2, 1]);
});

test("the order a box goes onto: its lot's order first, then the soonest due", () => {
  const p = pack({
    lines: [
      line({ id: "a", orderNo: 30, skuId: "s1", dispatchOn: "2026-11-02" }),
      line({ id: "b", orderNo: 20, skuId: "s1", dispatchOn: "2026-11-05", alloc: [{ id: "x", lotCode: "LOT1", qty: 2, scanned: 0 }] }),
      line({ id: "c", orderNo: 10, skuId: "s1", dispatchOn: "2026-11-03" }),
    ],
  });
  assert.equal(orderForUnit(p, unit({ id: B1, skuId: "s1" })), 20);
  assert.equal(orderForUnit(p, unit({ id: B1, skuId: "s1", lotCode: "LOT9" })), 30);
  /* An approved override names its own line. */
  assert.equal(orderForUnit({ ...p, overrides: [{ unitId: B1, lineId: "c" }] }, unit({ id: B1, skuId: "s1" })), 10);
});

test("an order with stickers loads by box and sticker, in either order", () => {
  const base = pack({
    lines: [line({ id: "l1", orderNo: 10, skuId: "s1", stickered: true, alloc: [{ id: "bc1", lotCode: "LOT1", qty: 2, scanned: 0 }] })],
    units: [unit({ id: B1, skuId: "s1" }), unit({ id: B2, skuId: "s1" })],
    stickers: [
      { id: "DS-AAAAAA", status: "active", lineId: "l1", orderNo: 10, unitId: null },
      { id: "DS-BBBBBB", status: "active", lineId: "l1", orderNo: 10, unitId: null },
      { id: "DS-CCCCCC", status: "cancelled", lineId: "l1", orderNo: 10, unitId: null },
    ],
  });
  /* Box first: held, then its sticker puts it on. */
  const box = judgeLorryScan(base, B1, null);
  assert.deepEqual([box.result, box.held], ["half", B1]);
  assert.equal(judgeLorryScan(base, B2, B1).result, "refused");
  assert.equal(judgeLorryScan(base, B1, B1).result, "repeat");
  const on = judgeLorryScan(base, "ds-aaaaaa", B1);
  assert.deepEqual([on.result, on.line, on.held], ["accepted", "l1", null]);
  const p = applyLocal(base, on);
  assert.equal(p.stickers[0].unitId, B1);
  assert.equal(judgeLorryScan(p, "DS-AAAAAA", null).result, "repeat");
  /* Sticker first, then its box. */
  const st = judgeLorryScan(p, "DS-BBBBBB", null);
  assert.deepEqual([st.result, st.held], ["half", "DS-BBBBBB"]);
  assert.equal(judgeLorryScan(p, "DS-AAAAAA", "DS-BBBBBB").result, "repeat");
  assert.equal(judgeLorryScan(p, B2, "DS-BBBBBB").result, "accepted");
  assert.equal(judgeLorryScan(p, "DS-CCCCCC", null).result, "refused");
  assert.equal(judgeLorryScan(p, "DS-ZZZZZZ", null).result, "unknown");
  /* A lot label while a half is held is refused, and the half kept. */
  const lot = judgeLorryScan(p, "PB-1", B2);
  assert.deepEqual([lot.result, lot.held], ["refused", B2]);
});

test("nothing left on the lorry refuses whatever is scanned", () => {
  assert.equal(judgeLorryScan(pack({}), B1, null).result, "refused");
});
