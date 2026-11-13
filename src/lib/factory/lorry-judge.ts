import { looksLikeUnitId, normaliseCode, scanVerdict, type ScanLine, type ScanUnit, type ScanVerdict } from "@/lib/erp/engines/trace";
import { stickerCode } from "./rules";
import type { Lorry, LorryBatchResult, LorryHalf } from "./types";

/* ---------------------------------------------------------------------------
 * THE LORRY'S SCAN, JUDGED ON THE PHONE. `lorryScan` on the server picks the
 * order a box goes onto and the desk's `scanVerdict` judges it there; this is
 * the same decision made against a LOADING PACK — the lorry's lines, the boxes
 * that could go on it, its stickers, approved overrides and what each lot has
 * free — downloaded when the lorry is opened. It writes nothing and reads
 * nothing: pure, so the phone and the server run one copy of the rule.
 *
 * IT NOW DECIDES WHAT THE LOADER HEARS. It shipped predicting only — the
 * server judged and the phone's answer rode beside it — and the loaders lost
 * boxes waiting on that round trip: a label every second against a reply
 * every two to eight, and every refusal throwing away the queue behind it.
 * So the offline-first phone sounds THIS answer the instant a label is read,
 * keeps the scan on disk, and sends it behind the loader in `follow` batches
 * (`scan-batch.ts`). The server still has the last word: where it refuses what
 * this took, the phone says so loudly when the answer lands (`settle`), and
 * `factory_scan_events` keeps both answers and whether they agreed.
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
  /** The desk's own sentence for a refusal, where the desk gave one. */
  message?: string;
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
  const say = (result: LocalResult, why: string, next: string | null = keep, line: string | null = null, message?: string): LocalJudgement => ({ result, line, held: next, why, code, ...(message ? { message } : {}) });
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
      return say(repeat ? "repeat" : "refused", v.result, null, null, v.message);
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
    if (!v.ok) return say(v.result === "duplicate" && onLorry(unit) ? "repeat" : "refused", v.result, null, null, v.message);
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

/* ---------------------------------------------------------------------------
 * WHAT THE LOADER IS TOLD, from the phone's own answer. The words are the
 * server's — `LORRY_VERDICT` and `lorryWords` moved here from `lorry.ts`, which
 * now reads them from this file — so a box refused on the phone and one refused
 * by the server are said the same way.
 * ------------------------------------------------------------------------- */

/** The desk's verdict, said for a loader: a title and what to do. */
export const LORRY_VERDICT: Record<string, [string, string]> = {
  unknown: ["We do not know this label", "Scan it again, closer. If it is torn, tell the dispatch head."],
  duplicate: ["Already on the lorry", "Scan the next box."],
  mismatch: ["Wrong stock — do not load", "Keep it aside. Load only what this lorry shows, or ask for an override."],
  blocked: ["Do not load this", "Keep it aside. Ask the dispatch head."],
};

/** The desk speaks of orders; a loader never sees one. */
export function lorryWords(m: string): string {
  return m
    .replace(/\border \d+ leaves from\b/g, "this lorry leaves from")
    .replace(/\b(on|onto) order \d+/g, "$1 another order")
    .replace(/\bthis order\b/g, "this lorry")
    .replace(/\bThis order\b/g, "This lorry");
}

const PHONE_REFUSAL: Record<string, [string, string, string]> = {
  empty: ["Nothing was read", "The label was empty.", "Scan the label again."],
  "nothing-left": ["Nothing left for this transport", "Everything going with it is loaded.", "Go back to Home."],
  "lot-not-free": ["No stock free in this lot", "This box's lot has nothing free to load.", "Keep it aside. Ask the dispatch head."],
  "sticker-cancelled": ["This sticker was cancelled", "It was taken off its order when the order changed.", "Peel it off. Print the order's stickers again."],
  "sticker-used": ["Already on a lorry", "This sticker is already on another box.", "Keep it aside. Scan the next one."],
  "sticker-not-this-lorry": ["Do not load this", "This sticker's order is not going on this lorry.", "Keep it aside. Ask the dispatch head."],
  "box-first": ["Scan its box first", "A sticker is waiting for its box.", "Finish that one, or press Cancel."],
  "sticker-first": ["Scan its sticker first", "A box is waiting for its dispatch sticker.", "Finish that one, or press Cancel."],
  "sticker-spent": ["Scan the sticker again", "The sticker you scanned is no longer free.", "Scan the box and its sticker again."],
};

export type LorrySay = { tone: "ok" | "warn" | "bad" | "wait"; title: string; text: string; fix: string };

/** What the loader hears for the phone's answer. `null` — no pack yet — is a scan the office will judge. */
export function sayLocal(j: LocalJudgement | null): LorrySay {
  const wait: LorrySay = { tone: "wait", title: "Checking with the office", text: "Carry on — this one is counted when the office answers.", fix: "" };
  if (!j || j.result === "unknown" || j.result === "lot") return wait;
  if (j.result === "accepted") {
    const swap = j.verdict?.allocation === "swap";
    return { tone: swap ? "warn" : "ok", title: swap ? "Lot swapped" : "On the lorry", text: lorryWords(j.verdict?.message ?? ""), fix: "" };
  }
  if (j.result === "half") return { tone: "ok", title: j.why === "sticker-read" ? "Sticker read" : "Box read", text: halfOf(j.held)?.says ?? "", fix: "" };
  if (j.result === "repeat") return { tone: "warn", title: "Already on — not counted again", text: j.code + " is already on this lorry.", fix: "Scan the next box." };
  const desk = LORRY_VERDICT[j.why];
  if (desk) return { tone: "bad", title: desk[0], text: lorryWords(j.message ?? j.code), fix: desk[1] };
  const p = PHONE_REFUSAL[j.why] ?? ["Not counted", j.code + " cannot go on this lorry.", "Keep it aside. Ask the dispatch head."];
  return { tone: "bad", title: p[0], text: p[1], fix: p[2] };
}

/** The half a pair is waiting on, in the words the server would use. */
export function halfOf(held: string | null): LorryHalf | null {
  if (!held) return null;
  return stickerCode(held)
    ? { kind: "sticker", code: held, says: "Now scan the box this sticker is on" }
    : { kind: "box", code: held, says: "Now scan the dispatch sticker on this box" };
}

/** The lorry's counts once a box the phone accepted is on: its item and the lorry one more. */
export function bumpLorry(lorry: Lorry, pack: LoadingPack, j: LocalJudgement): Lorry {
  if (j.result !== "accepted" || !j.verdict) return lorry;
  const sku = pack.lines.find((l) => l.id === j.verdict!.lineId)?.skuId;
  if (!sku || !lorry.items.some((i) => i.sku === sku)) return lorry;
  return { ...lorry, loaded: lorry.loaded + 1, items: lorry.items.map((i) => (i.sku === sku ? { ...i, loaded: i.loaded + 1 } : i)) };
}

/**
 * The server's answer to a scan the phone already sounded, and what the
 * loader must now be told:
 *   `quiet`   — the two agree, or the phone refused it (the server only recorded it);
 *   `counted` — the phone could not judge it and the server put it on;
 *   `refused` — the server will not count it: counted on the phone and taken
 *               back, or never judged on the phone and refused here. Loud.
 */
export function settle(localResult: string | null, r: LorryBatchResult): "quiet" | "counted" | "refused" {
  if (localResult === "refused") return "quiet";
  const known = localResult === "accepted" || localResult === "half" || localResult === "repeat";
  if (r.ok && !r.half) return known ? "quiet" : "counted";
  if (!r.ok && r.repeat) return "quiet";
  /* A half read by the server the phone never held: the pair cannot be finished after the loader moved on. */
  if (r.ok && r.half) return localResult === "half" ? "quiet" : "refused";
  return "refused";
}
