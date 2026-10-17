/* ---------------------------------------------------------------------------
 * Production and re-order arithmetic (spec §7–§10), PURE: the form previews
 * it, the server stores it and every report reads it through these functions,
 * so the three can never disagree.
 *
 * Money is paise; quantities are litres, cans or boxes as the stage says.
 * ------------------------------------------------------------------------- */

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/* ================================================================== SFG */

/** A batch line's consumption of its raw-material lot: batches × quantity per batch. */
export function sfgTotalUse(batches: number, qtyPerBatch: number): number {
  return r3(batches * qtyPerBatch);
}

/** What a batch line puts into SFG stock: its consumption less what was lost (spec §7.1). */
export function sfgYield(totalUse: number, litresAdjusted: number): number {
  return r3(totalUse - (litresAdjusted || 0));
}

/** The SFG lot code: the batch's first line names it, SFG No & its raw-material lot. */
export function sfgLotCode(sfgNo: number, firstRmLot: string): string {
  return `${sfgNo}${firstRmLot}`;
}

/**
 * The SFG rate of a lot: Σ purchase costing ÷ Σ consumption over its lines.
 * Null where a line's raw-material rate is unknown — a rate averaged over the
 * lines that happen to have one would be a lower number wearing the same name.
 */
export function sfgRate(lines: { totalUse: number; rmRatePaise: number | null }[]): number | null {
  let cost = 0;
  let use = 0;
  for (const l of lines) {
    if (l.rmRatePaise == null) return null;
    cost += l.rmRatePaise * l.totalUse;
    use += l.totalUse;
  }
  return use > 0 ? Math.round(cost / use) : null;
}

/* =================================================================== FG */

/** The FG lot code: "FG" & FG Num & the godown's first two letters, upper-cased. */
export function fgLotCode(fgNum: number, godownName: string): string {
  return `FG${fgNum}${godownName.slice(0, 2).toUpperCase()}`;
}

/** The packing-batch number: "FP" & Batch Serial & the godown's first two letters. */
export function packBatchNo(serial: number, godownName: string): string {
  return `FP${serial}${godownName.slice(0, 2).toUpperCase()}`;
}

export type FillFigures = {
  useLitres: number;
  /** What the fill puts into FG stock: net of cans lost (spec §14 A-12). */
  cansAvailable: number;
  costingPaise: number | null;
  /** Per can for a can, per litre otherwise (spec §8.2). */
  ratePaise: number | null;
  rateBasis: "can" | "litre";
};

export function fillFigures(p: {
  canSize: number;
  cans: number;
  canAdjusted: number;
  packingType: string;
  sfgRatePaise: number | null;
  /** The can or drum item's price; a Naket fill costs no packing. */
  packingRatePaise: number | null;
}): FillFigures {
  const useLitres = r3(p.canSize * p.cans);
  const cansAvailable = p.cans - (p.canAdjusted || 0);
  const packing = p.packingType === "Naket" ? 0 : p.packingRatePaise;
  const costingPaise = p.sfgRatePaise == null || packing == null ? null : Math.round(p.sfgRatePaise * useLitres + p.cans * packing);
  const rateBasis = p.packingType === "Can" ? "can" : "litre";
  const ratePaise =
    costingPaise == null ? null : rateBasis === "can" ? (p.cans > 0 ? Math.round(costingPaise / p.cans) : null) : useLitres > 0 ? Math.round(costingPaise / useLitres) : null;
  return { useLitres, cansAvailable, costingPaise, ratePaise, rateBasis };
}

/**
 * Why a fill cannot be saved, in the source's words — one message per failed
 * check (spec §14 A-11), or null.
 */
export function fillRefusal(p: { useLitres: number; sfgAvailable: number; cans: number; packingAvailable: number | null; packingType: string }): string | null {
  if (!(p.cans > 0)) return "Minus Quantity Not Allowed";
  if (!(p.sfgAvailable > 0) || p.useLitres > p.sfgAvailable + 1e-9) return "Low SFG Stock";
  if (p.packingType !== "Naket" && (p.packingAvailable == null || p.packingAvailable <= 0)) return "Low Packing Quantity";
  return null;
}

/* ============================================================== packing */

export type PackLine = { id: string; cans: number };

export type BatchState = {
  totalCans: number;
  usedCans: number;
  remaining: number;
  complete: boolean;
};

/** Where a packing batch stands: every line draws cans towards boxes × cans per box. */
export function batchState(boxes: number, cansPerBox: number, lines: PackLine[]): BatchState {
  const totalCans = boxes * cansPerBox;
  const usedCans = lines.reduce((a, l) => a + l.cans, 0);
  return { totalCans, usedCans, remaining: totalCans - usedCans, complete: totalCans > 0 && usedCans === totalCans };
}

/** Empty boxes a batch consumes, and what they cost. */
export function boxFigures(boxes: number, emptyBoxesRequired: number, boxRatePaise: number | null) {
  const emptyBoxes = boxes * (emptyBoxesRequired || 0);
  return { emptyBoxes, boxAmountPaise: boxRatePaise == null ? null : Math.round(emptyBoxes * boxRatePaise) };
}

/**
 * Each line's packing costing: its cans at their FG lot's per-can rate, plus a
 * share of the batch's box amount by cans (spec §14 A-13) — so a two-line
 * batch pays for its boxes once, not twice.
 */
export function packCosting(
  lines: { id: string; cans: number; fgRatePaise: number | null }[],
  boxAmountPaise: number | null,
): Map<string, number | null> {
  const total = lines.reduce((a, l) => a + l.cans, 0);
  const out = new Map<string, number | null>();
  for (const l of lines) {
    if (l.fgRatePaise == null || boxAmountPaise == null || total <= 0) out.set(l.id, null);
    else out.set(l.id, Math.round(l.fgRatePaise * l.cans + (boxAmountPaise * l.cans) / total));
  }
  return out;
}

/* =============================================================== levels */

/** Re-order % of a raw-material level: available ÷ midpoint − 1 (spec §10.2). */
export function rmReorderPercent(available: number | null, min: number, max: number): number | null {
  const mid = (min + max) / 2;
  if (available == null || mid <= 0) return null;
  return Math.round((available / mid - 1) * 1000) / 10;
}

/** What to buy to reach the maximum; blank when already at or above it. */
export function rmRequired(available: number | null, max: number): number | null {
  if (available == null) return null;
  const need = r3(max - available);
  return need > 0 ? need : null;
}

/** Re-order % of a finished-goods level: available ÷ minimum. */
export function fgReorderPercent(available: number, min: number): number | null {
  return min > 0 ? Math.round((available / min) * 1000) / 10 : null;
}

/* ============================================================ suggestions */

export type LevelSuggestion = { min: number; max: number; perDay: number; recentPerDay: number; basis: string; swing: string | null };

/**
 * AI-7's suggested level, DETERMINISTIC: average daily use over the look-back,
 * times the cover days, rounded up to whole units. Where the last 30 days run
 * at under half or over one and a half times the look-back rate it says so,
 * because a level set from a slack quarter runs out in a busy month.
 */
export function suggestLevel(p: { used: number; lookbackDays: number; recentUsed: number; recentDays: number; minCover: number; maxCover: number; unit: string }): LevelSuggestion | null {
  if (p.used <= 0 || p.lookbackDays <= 0) return null;
  const perDay = p.used / p.lookbackDays;
  const recentPerDay = p.recentDays > 0 ? p.recentUsed / p.recentDays : perDay;
  const round = (v: number) => Math.round(v * 10) / 10;
  const ratio = perDay > 0 ? recentPerDay / perDay : 1;
  const swing = ratio > 1.5 ? `The last ${p.recentDays} days ran at ${round(recentPerDay)} ${p.unit}/day, well above the ${p.lookbackDays}-day average.` : ratio < 0.5 ? `The last ${p.recentDays} days ran at ${round(recentPerDay)} ${p.unit}/day, well below the ${p.lookbackDays}-day average.` : null;
  return {
    min: Math.ceil(perDay * p.minCover),
    max: Math.ceil(perDay * p.maxCover),
    perDay: round(perDay),
    recentPerDay: round(recentPerDay),
    basis: `Used ${round(perDay)} ${p.unit}/day over ${p.lookbackDays} days; ${p.minCover}–${p.maxCover} days' cover.`,
    swing,
  };
}
