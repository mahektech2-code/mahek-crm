/* ---------------------------------------------------------------------------
 * The catalogue's rules, with no I/O in them.
 *
 * Two things live here: how a name becomes a match key, and how a quantity in
 * cans becomes litres and boxes. Both are pure, so both are tested without a
 * database — and both are the kind of rule that goes wrong quietly if every
 * caller writes its own version.
 * ------------------------------------------------------------------------- */

/**
 * The normalised name — point 5's "normalised", stored beside the raw one.
 *
 * Spacing collapsed, brackets spaced consistently, and "Can/box" standardised
 * to "Can/Box", because the source spells the same packing three ways. What
 * comes out is a name a human reads on a screen; it is not the match key.
 */
export function canonicalName(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s*\)/g, ")")
    .replace(/can\/box/gi, "Can/Box")
    .trim();
}

/**
 * The match key behind a name: letters and digits only.
 *
 * Legacy order lines carry the description as text, typed by whoever typed it,
 * so "Nano Thinner - 5 Liter (6 Can/Box)" and "Nano Thinner 5 Liter(6 can/box)"
 * have to reach the same SKU. Casing, spacing and punctuation are exactly the
 * differences that mean nothing here.
 */
export function matchKey(name: string): string {
  return canonicalName(name).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The slug a formulation, brand or finished good is found by. */
export const catalogueSlug = matchKey;

/* --------------------------------------------------------------- quantity */

export type PackingConfig = {
  /** Millilitres in one can. Null on a row that predates the catalogue. */
  millilitresPerCan: number | null;
  /** 1 for loose cans and for drums, which are one container, not a box of them. */
  cansPerBox: number;
};

/**
 * Litres for a number of cans.
 *
 * Point 11: cans are the source of truth, and litres are derived every time
 * they are shown. Storing litres instead would lose "six cans" the moment the
 * pack size changed, and pack sizes here run from 0.5 L to 210 L.
 */
export function litresFor(cans: number, sku: PackingConfig): number | null {
  if (sku.millilitresPerCan == null) return null;
  return (cans * sku.millilitresPerCan) / 1000;
}

/**
 * Whole boxes and the cans left over.
 *
 * Loose SKUs have no box, so everything is a remainder — that is the honest
 * answer rather than a zero that reads as "none".
 */
export function boxesFor(
  cans: number,
  sku: PackingConfig,
): { boxes: number; looseCans: number } {
  const perBox = sku.cansPerBox > 0 ? sku.cansPerBox : 1;
  if (perBox === 1) return { boxes: 0, looseCans: cans };
  return { boxes: Math.floor(cans / perBox), looseCans: cans % perBox };
}

/**
 * Transport weight for a quantity, in grams, or null where the SKU carries no
 * weight. Point 12: the stored figure is per BOX where there is a box and per
 * CAN where there is not, and adding the two kinds together would be nonsense
 * — so the basis decides the multiplier, never the caller.
 */
export function weightFor(
  cans: number,
  sku: PackingConfig & { weightGrams: number | null; weightBasis: "box" | "can" },
): number | null {
  if (sku.weightGrams == null) return null;
  if (sku.weightBasis === "can") return cans * sku.weightGrams;
  const perBox = sku.cansPerBox > 0 ? sku.cansPerBox : 1;
  // Part boxes still travel, so this rounds up rather than truncating.
  return Math.ceil(cans / perBox) * sku.weightGrams;
}

/** "12 cans · 60 L · 2 boxes" — one phrasing, so two screens cannot differ. */
export function describeQuantity(cans: number, sku: PackingConfig): string {
  const parts = [`${cans} ${cans === 1 ? "can" : "cans"}`];
  const litres = litresFor(cans, sku);
  if (litres != null) parts.push(`${trim(litres)} L`);
  const { boxes, looseCans } = boxesFor(cans, sku);
  if (boxes > 0) {
    parts.push(`${boxes} ${boxes === 1 ? "box" : "boxes"}${looseCans ? ` + ${looseCans}` : ""}`);
  }
  return parts.join(" · ");
}

/** Two decimals at most, and none where the number is whole. */
function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/* ------------------------------------------------------- order valuation */

/**
 * Where a line's price is meant to come from. The catalogue document carries
 * no price at all, so this starts unanswered and the answer is a decision
 * somebody makes once — see `canValueOrders`.
 */
export type PriceSource = "unset" | "product" | "pricelist" | "manual";

/**
 * Whether a line's value may be computed at all.
 *
 * Point 15: until a price source is confirmed there is no honest way to value
 * an order, and the wrong way — reaching for the packing cost, because it is
 * the only number on the row — produces figures that look right on a target
 * screen and are not. So valuation asks first, and everything downstream of it
 * says "not yet" rather than showing a confident zero.
 */
export function canValueOrders(source: PriceSource): boolean {
  return source !== "unset";
}

/**
 * A line's value in paise, or null when nothing may be computed yet.
 *
 * `manual` means the telecaller typed the amount, so the typed figure stands
 * and the catalogue has no opinion. `product` reads the SKU's own price, which
 * is null until somebody sets it — and a null price is not a free product, so
 * it stays null rather than becoming zero.
 */
export function lineValuePaise(
  source: PriceSource,
  cans: number,
  sku: { sellingPricePaise: number | null },
  typedPaise: number | null,
): number | null {
  if (!canValueOrders(source)) return null;
  if (source === "manual") return typedPaise;
  if (source === "product") {
    return sku.sellingPricePaise == null ? null : cans * sku.sellingPricePaise;
  }
  // A customer price list is not built yet; until it is, nothing is claimed.
  return typedPaise;
}
