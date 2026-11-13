import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScanUnit } from "@/lib/erp/engines/trace";
import { applyLocal, bumpLorry, halfOf, judgeLorryScan, orderForUnit, sayLocal, settle, type LoadingPack, type PackLine } from "./lorry-judge";
import type { Lorry, LorryBatchResult } from "./types";

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

/* ---------------------------------------------------------------- offline-first loading */

test("the phone says its own answer: on, repeat, refused in the desk's words, and wait where it cannot judge", () => {
  let p = pack({
    lines: [line({ id: "l1", orderNo: 10, skuId: "s1", alloc: [{ id: "bc1", lotCode: "LOT1", qty: 2, scanned: 0 }] })],
    units: [unit({ id: B1, skuId: "s1" }), unit({ id: B2, skuId: "s9", productId: "pr-other" })],
  });
  const on = judgeLorryScan(p, B1, null);
  assert.equal(sayLocal(on).tone, "ok");
  assert.equal(sayLocal(on).title, "On the lorry");
  p = applyLocal(p, on);
  assert.equal(sayLocal(judgeLorryScan(p, B1, null)).tone, "warn");
  const wrong = sayLocal(judgeLorryScan(p, B2, null));
  assert.equal(wrong.tone, "bad");
  assert.equal(wrong.title, "Wrong stock — do not load");
  assert.ok(!/order \d/.test(wrong.text), "a loader is never shown an order: " + wrong.text);
  assert.equal(sayLocal(judgeLorryScan(p, BX, null)).tone, "wait");
  assert.equal(sayLocal(judgeLorryScan(p, "DS-46487", null)).tone, "wait", "a slip that is not a box label is the office's to judge");
  assert.equal(sayLocal(null).tone, "wait", "no pack yet: every scan waits for the office, none is lost");
});

test("an accepted box moves the lorry's counts on the phone, before the server has heard of it", () => {
  const p = pack({ lines: [line({ id: "l1", orderNo: 10, skuId: "s1", alloc: [{ id: "bc1", lotCode: "LOT1", qty: 2, scanned: 0 }] })], units: [unit({ id: B1, skuId: "s1" })] });
  const lorry: Lorry = { key: "L:vrl", name: "VRL", items: [{ sku: "s1", label: "S1", unit: "boxes", target: 2, loaded: 0, orders: 1, late: false, notBilled: false, byLot: false }], target: 2, loaded: 0, orders: 1, late: 0, due: null, task: null, loader: null };
  const after = bumpLorry(lorry, p, judgeLorryScan(p, B1, null));
  assert.equal(after.loaded, 1);
  assert.equal(after.items[0].loaded, 1);
  assert.equal(bumpLorry(lorry, p, judgeLorryScan(p, BX, null)), lorry, "nothing moves for a scan the phone could not judge");
});

test("a half is said the way the server says it", () => {
  assert.equal(halfOf(null), null);
  assert.equal(halfOf(B1)?.kind, "box");
  assert.match(halfOf(B1)!.says, /sticker/);
});

test("settling the server's answer: agreement is quiet, a late yes is counted, any no the phone did not say is loud", () => {
  const ok = { ok: true, id: "a", code: B1, tone: "ok", title: "On the lorry", message: "", task: "T-1" } as LorryBatchResult;
  const no = { ok: false, id: "a", code: B1, title: "Do not load this", text: "", fix: "", task: null, override: null } as LorryBatchResult;
  const rep = { ...no, repeat: true } as LorryBatchResult;
  const half = { ...ok, half: { kind: "box", code: B1, says: "" } } as LorryBatchResult;
  assert.equal(settle("accepted", ok), "quiet");
  assert.equal(settle("repeat", rep), "quiet");
  assert.equal(settle("refused", no), "quiet", "the phone already said no, and the server only recorded it");
  assert.equal(settle("accepted", no), "refused", "counted on the phone, refused by the office: the loader must hear it");
  assert.equal(settle("unknown", ok), "counted");
  assert.equal(settle(null, ok), "counted");
  assert.equal(settle("lot", no), "refused");
  assert.equal(settle("half", half), "quiet");
  assert.equal(settle("unknown", half), "refused", "a pair the phone never held cannot be finished after the loader moved on");
});
