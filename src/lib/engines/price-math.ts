/* ---------------------------------------------------------------------------
 * THE ARITHMETIC OF A PRICE LIST, with no I/O in it.
 *
 * Everything a screen, a parser, an action or a handset needs to turn one
 * number into another: inclusive from ex-GST and back, a derived list from its
 * parent, a slab from a quantity, a discount against somebody's authority, and
 * a line's worth. Pure, like every engine here, because two of these callers
 * cannot reach a database — the parser runs over text and the order form runs
 * in a browser — and a rule that lives in three places is a rule that drifts
 * in the one somebody is reading.
 *
 * MONEY IS PAISE AND THE STORED RATE IS EX-GST. The PDFs print inclusive and
 * the order sheet bills ex-GST; times 1.18 lands on the PDF to the rupee across
 * every sample, which is what makes the stored side a decision rather than a
 * guess. Rounding is to the RUPEE on the way to inclusive, because that is what
 * the office prints, and `exFromIncl` divides without rounding so the round
 * trip through a printed figure loses nothing that a printed figure had.
 * ------------------------------------------------------------------------- */

import type { PriceDerivation } from "@/db/schema";

/** Basis points as the whole: 1800 is 18%. */
const BP = 10_000;

/** Round paise to the nearest whole rupee. */
export function roundToRupee(paise: number): number {
  return Math.round(paise / 100) * 100;
}

/**
 * GST-inclusive per can from ex-GST, rounded to the rupee — the figure the
 * office prints and the shop is told.
 */
export function inclFromEx(exPaise: number, gstBp: number): number {
  return roundToRupee(Math.round(exPaise * (1 + gstBp / BP)));
}

/**
 * Ex-GST from a printed inclusive figure. NOT rounded to the rupee: the sheet
 * bills 1,933 against a printed 2,281 and 1932.20 would bill as 1,932, which is
 * the wrong rupee on every line for the rest of the month. Paise are kept and
 * the rupee is decided where the money is, never here.
 */
export function exFromIncl(inclPaise: number, gstBp: number): number {
  return Math.round(inclPaise / (1 + gstBp / BP));
}

/**
 * A derived rate from its parent's ex-GST rate.
 *
 * `per_litre_paise` is the Odisha rule — freight per litre, so a 20 L can moves
 * by twenty times what a 1 L can does. `percent_bp` is a margin or a revision.
 * `per_can_paise` is the tin-can premium, flat whatever the size.
 */
export function deriveRate(
  parentExPaise: number,
  millilitresPerCan: number | null,
  derivation: PriceDerivation,
): number | null {
  switch (derivation.kind) {
    case "per_litre_paise":
      if (millilitresPerCan == null) return null;
      return Math.round(parentExPaise + (derivation.paise * millilitresPerCan) / 1000);
    case "percent_bp":
      return Math.round(parentExPaise * (1 + derivation.bp / BP));
    case "per_can_paise":
      return Math.round(parentExPaise + derivation.paise);
  }
}

/** Reading a derivation off two lists: what rule turns the parent into the child. */
export function inferDerivation(
  pairs: Array<{ parentExPaise: number; childExPaise: number; millilitresPerCan: number | null }>,
): PriceDerivation | null {
  const usable = pairs.filter((p) => p.millilitresPerCan != null && p.millilitresPerCan > 0);
  if (usable.length < 2) return null;

  const perLitre = usable.map((p) => ((p.childExPaise - p.parentExPaise) * 1000) / p.millilitresPerCan!);
  if (agree(perLitre, 300)) return { kind: "per_litre_paise", paise: Math.round(median(perLitre)) };

  const percent = usable.map((p) => ((p.childExPaise - p.parentExPaise) / p.parentExPaise) * BP);
  if (agree(percent, 25)) return { kind: "percent_bp", bp: Math.round(median(percent)) };

  const perCan = usable.map((p) => p.childExPaise - p.parentExPaise);
  if (agree(perCan, 300)) return { kind: "per_can_paise", paise: Math.round(median(perCan)) };

  return null;
}

function agree(values: number[], tolerance: number): boolean {
  const m = median(values);
  return values.every((v) => Math.abs(v - m) <= tolerance);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ------------------------------------------------------------------ slabs */

export type SlabRate = {
  rateExGstPaise: number;
  minCans: number | null;
  maxCans: number | null;
  offered: boolean;
};

/**
 * The slab a quantity falls in. A flat price has no bounds and always
 * applies; a slabbed SKU picks the narrowest slab the quantity satisfies. A
 * row printed as a dash is listed and not for sale, and answers null.
 */
export function pickSlab<T extends SlabRate>(rates: readonly T[], cans: number): T | null {
  const candidates = rates.filter(
    (r) => r.offered && (r.minCans == null || cans >= r.minCans) && (r.maxCans == null || cans <= r.maxCans),
  );
  if (!candidates.length) return null;
  return candidates.sort((a, b) => (b.minCans ?? 0) - (a.minCans ?? 0))[0];
}

/* --------------------------------------------------------------- discount */

export type DiscountLevel = "associate" | "manager" | "admin";

export type DiscountAuthority = {
  /** What THIS person may give on their own, in basis points. */
  maxBp: number;
  /** Whether the asked-for discount is inside that. */
  allowed: boolean;
  /** The sentence a screen prints when it is not. */
  reason: string | null;
};

/**
 * Whether somebody may give this much off without asking.
 *
 * A telecaller's ceiling and a manager's ceiling are configuration, and an
 * admin holds everything everywhere as usual. Zero for associates is the
 * shipped default: the sample lists state 3% and 2% under named conditions and
 * nothing else, and the order sheet shows 10% being given with nobody's name
 * against it — which is the thing this exists to stop.
 */
export function discountAuthority(
  discountBp: number,
  level: DiscountLevel,
  config: { associateMaxBp: number; managerMaxBp: number },
): DiscountAuthority {
  if (discountBp < 0) return { maxBp: 0, allowed: false, reason: "A discount cannot be negative." };
  const maxBp =
    level === "admin" ? BP : level === "manager" ? config.managerMaxBp : config.associateMaxBp;
  if (discountBp <= maxBp) return { maxBp, allowed: true, reason: null };
  return {
    maxBp,
    allowed: false,
    reason:
      maxBp === 0
        ? "You cannot give a discount on your own. Ask a manager to authorise it."
        : `You may give up to ${pctLabel(maxBp)} on your own. Above that a manager has to authorise it.`,
  };
}

export function pctLabel(bp: number): string {
  const pct = bp / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`;
}

/* ------------------------------------------------------------------ a line */

export type PricedLine = {
  /** Cans times the list rate, ex-GST. */
  grossExPaise: number;
  discountPaise: number;
  netExPaise: number;
  gstPaise: number;
  /** What the shop pays for the line. */
  totalPaise: number;
};

/** One line's worth, every figure in paise, the discount taken before GST. */
export function priceLine(input: {
  rateExGstPaise: number;
  cans: number;
  discountBp?: number | null;
  gstBp: number;
}): PricedLine {
  const grossExPaise = Math.round(input.rateExGstPaise * input.cans);
  const discountPaise = Math.round((grossExPaise * (input.discountBp ?? 0)) / BP);
  const netExPaise = grossExPaise - discountPaise;
  const gstPaise = Math.round((netExPaise * input.gstBp) / BP);
  return { grossExPaise, discountPaise, netExPaise, gstPaise, totalPaise: netExPaise + gstPaise };
}

/** Per litre, for reading two pack sizes against each other. Null where the pack is unknown. */
export function perLitrePaise(rateExGstPaise: number, millilitresPerCan: number | null): number | null {
  if (!millilitresPerCan) return null;
  return Math.round((rateExGstPaise * 1000) / millilitresPerCan);
}

/**
 * The difference between two rates, for a comparison screen: rupees and
 * percent, signed. Percent is null from nothing, because "up 3,900%" from an
 * unpriced row is a number nobody meant.
 */
export function rateChange(
  fromExPaise: number | null,
  toExPaise: number | null,
): { deltaPaise: number | null; deltaBp: number | null } {
  if (fromExPaise == null || toExPaise == null) return { deltaPaise: null, deltaBp: null };
  const deltaPaise = toExPaise - fromExPaise;
  const deltaBp = fromExPaise === 0 ? null : Math.round((deltaPaise / fromExPaise) * BP);
  return { deltaPaise, deltaBp };
}
