import { looksLikeUnitId, normaliseCode, scanVerdict, type ScanLine, type ScanUnit, type ScanVerdict } from "@/lib/erp/engines/trace";
import { stickerCode } from "./rules";

/* ---------------------------------------------------------------------------
 * THE LORRY'S SCAN, JUDGED ON THE PHONE. `lorryScan` on the server picks the
 * order a box goes onto and the desk's `scanVerdict` judges it there; this is
 * the same decision made against a LOADING PACK — the lorry's lines, the boxes
 * that could go on it, its stickers, approved overrides and what each lot has
 * free — downloaded when the lorry is opened. It writes nothing and reads
 * nothing: pure, so the phone and the server run one copy of the rule.
 *
 * FOR NOW IT ONLY PREDICTS. The server still judges every scan, and the phone
 * sends this answer beside it; `factory_scan_events` stores both and whether
 * they agreed. A week of that is what decides whether a phone may count a box
 * on its own with no signal. Until then nothing a loader sees comes from here.
 *
 * Four things it cannot know, said rather than guessed:
 *   `unknown` — a code the pack does not carry (a box from another godown,
 *     another product, a sticker for another lorry). The server knows; the
 *     phone would hold it, never count it.
 *   `lot` — a lot label. Filling orders from a lot is a ledger question.
 * Neither is a disagreement when the server then says something definite.
 *
 * `applyLocal` moves the pack on by what an accepted scan wrote, so the next
 * box in a burst is judged against the lorry as it now stands.
 * ------------------------------------------------------------------------- */

/** A lorry line as the pack carries it: the desk's line, its due date, and whether its order's stickers carry ids. */
export type PackLine = ScanLine & { dispatchOn: string | null; stickered: boolean };
export type PackSticker = { id: string; status: string; lineId: string; orderNo: number; unitId: string | null };
/** What a lot has free in the stock ledger at this godown, as `lotFree` reads it. `skuId` null is the lot as a whole. */
export type PackFree = { lotFrom: "pack" | "fg"; lotCode: string; skuId: string | null; free: number };

export type LoadingPack = {
  key: string;
  godownId: string;
  /** When the server read it — every judgement made against it says how old it was. */
  at: string;
  lines: PackLine[];
  units: ScanUnit[];
  overrides: { unitId: string; lineId: string }[];
  stickers: PackSticker[];
  free: PackFree[];
};

export type LocalResult = "accepted" | "half" | "repeat" | "refused" | "unknown" | "lot";

export type LocalJudgement = {
  result: LocalResult;
  /** The line an accepted box goes onto. */
  line: string | null;
  /** The half the next scan goes with, as the server would say it. */
  held: string | null;
  /** Why, in a word, for reading a disagreement afterwards. */
  why: string;
  code: string;
  /** What `applyLocal` needs to move the pack on: the verdict, and the box — which is not `code` when a sticker completed the pair. */
  verdict?: Extract<ScanVerdict, { ok: true }>;
  unit?: string;
  sticker?: string;
};

const due = (l: PackLine) => l.dispatchOn ?? "9999";
const dueOrder = (a: PackLine, b: PackLine) => (due(a) < due(b) ? -1 : due(a) > due(b) ? 1 : a.orderNo - b.orderNo);

/** What a lot has free, as the server's `lotFree`: by SKU for a filled-can lot where the ledger says, else the lot. */
export function freeOf(pack: LoadingPack, u: ScanUnit): number {
  const of = pack.free.filter((f) => f.lotFrom === u.lotFrom && f.lotCode === u.lotCode);
  if (u.lotFrom === "pack") return of.find((f) => f.skuId == null)?.free ?? 0;
  return of.find((f) => f.skuId === u.skuId)?.free ?? of.find((f) => f.skuId == null)?.free ?? 0;
}

/** The order a box goes onto: an approved override's line, then one whose lot it is from, then the soonest due — `orderForBox`. */
export function orderForUnit(pack: LoadingPack, unit: ScanUnit | null): number {
  const lines = pack.lines;
  if (unit) {
    const ov = pack.overrides.find((o) => o.unitId === unit.id && lines.some((l) => l.id === o.lineId));
    const byOverride = ov && lines.find((l) => l.id === ov.lineId);
    if (byOverride) return byOverride.orderNo;
    const same = lines.filter((l) => l.skuId === unit.skuId);
    const open = same.filter((l) => l.scanned < l.target).sort((a, b) => {
      const la = a.alloc.some((x) => x.lotCode === unit.lotCode && x.scanned < x.qty) ? 0 : 1;
      const lb = b.alloc.some((x) => x.lotCode === unit.lotCode && x.scanned < x.qty) ? 0 : 1;
      return la - lb || dueOrder(a, b);
    });
    if (open.length) return open[0].orderNo;
    if (unit.orderNo != null && lines.some((l) => l.orderNo === unit.orderNo)) return unit.orderNo;
    if (same.length) return [...same].sort(dueOrder)[0].orderNo;
    const product = lines.filter((l) => l.productId != null && l.productId === unit.productId && l.scanned < l.target).sort(dueOrder)[0];
    if (product) return product.orderNo;
  }
  return [...lines].sort(dueOrder)[0].orderNo;
}

/** A box, a dispatch sticker or a lot label scanned on the lorry, judged as `lorryScan` would — against the pack. */
export function judgeLorryScan(pack: LoadingPack, raw: string, held: string | null): LocalJudgement {
  const sticker = stickerCode(String(raw ?? ""));
  const code = sticker ?? normaliseCode(String(raw ?? ""));
  const heldSticker = held ? stickerCode(held) : null;
  const heldBox = held && !heldSticker && looksLikeUnitId(normaliseCode(held)) ? normaliseCode(held) : null;
  const keep = heldSticker ?? heldBox;
  const say = (result: LocalResult, why: string, next: string | null = keep, line: string | null = null): LocalJudgement => ({ result, line, held: next, why, code });
  if (!code) return say("refused", "empty");
  if (!pack.lines.length) return say("refused", "nothing-left", null);
  const unitOf = (id: string) => pack.units.find((u) => u.id === id) ?? null;
  const onLorry = (u: ScanUnit | null) => !!u && u.status === "scanned" && pack.lines.some((l) => l.id === u.orderId);

  /* The pair is in: the box judged against the sticker's own line, as `scanOntoOrder` with a sticker. */
  const pair = (box: string, s: PackSticker): LocalJudgement => {
    const unit = unitOf(box);
    if (!unit) return say("unknown", "box-not-in-pack", null);
    const lines = pack.lines.filter((l) => l.id === s.lineId);
    const ov = pack.overrides.find((o) => o.unitId === unit.id && lines.some((l) => l.id === o.lineId));
    const v = scanVerdict(unit, lines, ov ? { lineId: ov.lineId } : null);
    if (!v.ok) {
      const repeat = v.result === "duplicate" && onLorry(unit) && pack.stickers.some((x) => x.id === s.id && x.unitId === box && x.status === "active");
      return say(repeat ? "repeat" : "refused", v.result, null);
    }
    if (v.allocation !== "matched" && freeOf(pack, unit) < 1 - 1e-9) return say("refused", "lot-not-free", null);
    return { result: "accepted", line: v.lineId, held: null, why: v.allocation, code, verdict: v, unit: unit.id, sticker: s.id };
  };

  if (sticker) {
    const s = pack.stickers.find((x) => x.id === sticker);
    if (!s) return say("unknown", "sticker-not-in-pack");
    if (s.status !== "active") return say("refused", "sticker-cancelled");
    if (s.unitId) return say(onLorry(unitOf(s.unitId)) ? "repeat" : "refused", "sticker-used");
    if (!pack.lines.some((l) => l.id === s.lineId)) return say("refused", "sticker-not-this-lorry");
    if (heldSticker && heldSticker !== sticker) return say("refused", "box-first");
    if (heldBox) return pair(heldBox, s);
    return say("half", "sticker-read", sticker);
  }

  if (looksLikeUnitId(code)) {
    if (heldSticker) {
      const s = pack.stickers.find((x) => x.id === heldSticker);
      if (!s || s.status !== "active" || s.unitId) return say("refused", "sticker-spent", null);
      return pair(code, s);
    }
    if (heldBox) return heldBox === code ? say("repeat", "same-box") : say("refused", "sticker-first");
    const unit = unitOf(code);
    if (unit && unit.status === "available" && unit.godownId === pack.godownId) {
      const wanting = pack.lines.filter((l) => l.skuId === unit.skuId && l.scanned < l.target);
      if (wanting.some((l) => l.stickered)) return say("half", "box-read", code);
    }
    if (!unit) return say("unknown", "box-not-in-pack", null);
    const orderNo = orderForUnit(pack, unit);
    const lines = pack.lines.filter((l) => l.orderNo === orderNo);
    const ov = pack.overrides.find((o) => o.unitId === unit.id && lines.some((l) => l.id === o.lineId));
    const v = scanVerdict(unit, lines, ov ? { lineId: ov.lineId } : null);
    if (!v.ok) return say(v.result === "duplicate" && onLorry(unit) ? "repeat" : "refused", v.result, null);
    if (v.allocation !== "matched" && freeOf(pack, unit) < 1 - 1e-9) return say("refused", "lot-not-free", null);
    return { result: "accepted", line: v.lineId, held: null, why: v.allocation, code, verdict: v, unit: unit.id };
  }

  if (keep) return say("refused", keep === heldBox ? "sticker-first" : "box-first");
  return say("lot", "lot-label", null);
}

/** The pack as it stands once an accepted box is on: the unit scanned, the line and its lots counted, the sticker claimed. */
export function applyLocal(pack: LoadingPack, j: LocalJudgement): LoadingPack {
  const v = j.verdict;
  if (j.result !== "accepted" || !v) return pack;
  const unit = pack.units.find((u) => u.id === j.unit);
  const line = pack.lines.find((l) => l.id === v.lineId);
  if (!unit || !line) return pack;
  let free = pack.free;
  const take = (u: { lotFrom: "pack" | "fg"; lotCode: string }, by: number) => {
    free = free.map((f) => (f.lotFrom === u.lotFrom && f.lotCode === u.lotCode && (u.lotFrom === "pack" || f.skuId == null || f.skuId === unit.skuId) ? { ...f, free: f.free - by } : f));
  };
  let alloc = line.alloc.map((a) => ({ ...a }));
  if (v.allocation === "matched") {
    const a = alloc.find((x) => x.id === v.batchCodeId);
    if (a) a.scanned += 1;
  } else {
    if (v.swapFromId) {
      const giver = alloc.find((x) => x.id === v.swapFromId);
      if (giver) {
        take({ lotFrom: unit.lotFrom, lotCode: giver.lotCode }, -1);
        giver.qty -= 1;
      }
      alloc = alloc.filter((x) => x.qty > 1e-9 || x.scanned > 0);
    }
    const mine = v.batchCodeId ? alloc.find((x) => x.id === v.batchCodeId) : undefined;
    if (mine) {
      mine.qty += 1;
      mine.scanned += 1;
    } else alloc.push({ id: `local:${unit.id}`, lotCode: unit.lotCode, qty: 1, scanned: 1 });
    take(unit, 1);
  }
  return {
    ...pack,
    units: pack.units.map((u) => (u.id === unit.id ? { ...u, status: "scanned", orderId: line.id, orderNo: line.orderNo } : u)),
    lines: pack.lines.map((l) => (l.id === line.id ? { ...l, scanned: l.scanned + 1, alloc } : l)),
    stickers: j.sticker ? pack.stickers.map((s) => (s.id === j.sticker ? { ...s, unitId: unit.id } : s)) : pack.stickers,
    free,
  };
}
