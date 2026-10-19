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

/* ----------------------------------------------------------- what a row says */

/**
 * WHICH LINE LEADS ON A PRODUCT ROW, and it is the FORMULATION now.
 *
 * Mahek sets a mix target on a formulation — `sales_target_categories` carries
 * `formulation_id`, nineteen liquids rather than the three categories above
 * them — and asked for the screens to match, so a salesman reads the same word
 * on the row he is adding to an order as on the target he is being judged
 * against. It was the other way round: the SKU name led and the formulation was
 * an 11px grey subtitle underneath it.
 *
 * WHAT IS *NOT* CHANGING IS WHAT IS ORDERED. Only a SKU can be put on an order
 * line — that rule is the whole reason the catalogue has four levels — and two
 * SKUs of one formulation differ only by their pack. So the SKU never leaves
 * the row, it moves to the second line: `Nano` over `Nano Thinner - 20 Liter
 * (Loose)`. Leading with the formulation ALONE would collapse two hundred
 * orderable rows onto nineteen labels and make the list ambiguous exactly where
 * a telecaller is on a call, which is the one place this app cannot afford it.
 *
 * It is also deliberately NOT `displayName`, which several callers PERSIST —
 * `product-field.tsx` writes it into a form value, `customer-info-service.ts`
 * prints it as the product's name. A composer that rewrote that field would
 * quietly start storing a liquid's name where a product's name belongs. This
 * returns the two lines to DRAW and touches neither the name nor the id.
 *
 * `detail` is null rather than empty in the two cases where a second line would
 * say nothing: no formulation on the row at all — a pre-catalogue SKU, or one
 * nobody has filed, which is most of an imported book — and a formulation whose
 * name is already the whole of the product's. A row whose second line repeats
 * its first reads as a rendering fault, and a BLANK headline over a real name is
 * worse: the fallback is always that there is exactly one line and it is the one
 * that identifies the thing.
 */
export function productLines(row: {
  /** The SKU as it is named and packed — `displayName` from the product service. */
  displayName: string;
  /** The formulation. Null on a pre-catalogue row, and on an unmatched one. */
  subtitle: string | null | undefined;
}): { lead: string; detail: string | null } {
  const sku = row.displayName.trim();
  const formulation = (row.subtitle ?? "").trim();

  if (!formulation) return { lead: sku, detail: null };
  /* Case-insensitively, because "nano" filed against "Nano Thinner" is the
     same restatement as "Nano" is, and neither is worth a second line. */
  if (!sku || sku.toLowerCase() === formulation.toLowerCase()) {
    return { lead: formulation, detail: null };
  }
  return { lead: formulation, detail: sku };
}

/* ------------------------------------------------------------ a new SKU */

/**
 * HOW A SKU IS PACKED, AS THE CONSOLE'S "ADD SKU" ASKS IT.
 *
 * Three answers, because the name and two stored figures follow from it: a box
 * holds several cans (`cans_per_box` > 1, weight per box); a loose can and a
 * drum are each ONE container (`cans_per_box` 1, weight per can). Loose and
 * drum are different answers although both are one container — a drum is a
 * container that costs something, which is what keeps a drum cost from ever
 * reading as a box cost (see `scripts/parse-catalogue.mjs`, `derivePacking`).
 */
export type PackingKind = "box" | "loose" | "drum";

/** 500 → "0.5 Liter", 5000 → "5 Liter" — the size as the catalogue spells it. */
export function sizeLabel(millilitres: number): string {
  return `${trim(millilitres / 1000)} Liter`;
}

/**
 * A finished good's name — "Nano Thinner - 5 Liter" — the shape the catalogue
 * document gives almost every row. A SUGGESTION: the console shows it and
 * somebody may change it, because a handful of real goods are spelled without
 * the dash and a new one should be able to match its siblings.
 */
export function finishedGoodNameFor(brand: string, millilitres: number): string {
  return canonicalName(`${brand.trim()} - ${sizeLabel(millilitres)}`);
}

/** "6 Can/Box", "Loose", "Drum" — what the name carries in its brackets. */
export function packingLabelFor(kind: PackingKind, cansPerBox: number): string {
  if (kind === "box") return `${cansPerBox} Can/Box`;
  return kind === "drum" ? "Drum" : "Loose";
}

/** "Nano Thinner - 5 Liter (6 Can/Box)". Also a suggestion — see above. */
export function skuNameFor(goodName: string, packing: string): string {
  return canonicalName(`${goodName.trim()} (${packing.trim()})`);
}

/** Everything about a new SKU that can be judged without the database. */
export type NewSkuDraft = {
  name: string;
  packingKind: PackingKind;
  cansPerBox: number;
  millilitresPerCan: number;
  packingCostPaise: number | null;
  weightGrams: number | null;
  sellingPricePaise: number | null;
  externalCode: number | null;
  aliases: string[];
};

/** A pack this size or larger is a typo — the largest drum sold is 210 L. */
export const MAX_MILLILITRES_PER_CAN = 250_000;
/** The largest real box holds 32 cans; a hundred is a typo. */
export const MAX_CANS_PER_BOX = 100;

/**
 * What is wrong with a new SKU, keyed by the field it is wrong about, so the
 * console can put each sentence under the box it names. Empty means nothing
 * this side can see — the action still checks the name and the legacy ID
 * against the catalogue, which only the database knows.
 *
 * The console runs this on every keystroke and `createSku` runs it again
 * before it writes, so the two cannot disagree about what is allowed.
 */
export function newSkuProblems(d: NewSkuDraft): Partial<Record<keyof NewSkuDraft, string>> {
  const out: Partial<Record<keyof NewSkuDraft, string>> = {};
  const name = canonicalName(d.name);
  if (name.length < 3) out.name = "A SKU needs a real name.";
  else if (name.length > 200) out.name = "That name is longer than any product name needs to be.";

  if (!Number.isInteger(d.cansPerBox) || d.cansPerBox < 1) {
    out.cansPerBox = "Cans per box is a whole number.";
  } else if (d.packingKind === "box" && d.cansPerBox < 2) {
    out.cansPerBox = "A box holds at least two cans — one can on its own is Loose.";
  } else if (d.packingKind !== "box" && d.cansPerBox !== 1) {
    out.cansPerBox = "A loose can or a drum is one container.";
  } else if (d.cansPerBox > MAX_CANS_PER_BOX) {
    out.cansPerBox = `No box holds more than ${MAX_CANS_PER_BOX} cans.`;
  }

  if (!Number.isInteger(d.millilitresPerCan) || d.millilitresPerCan < 1) {
    out.millilitresPerCan = "Say how much one can holds.";
  } else if (d.millilitresPerCan > MAX_MILLILITRES_PER_CAN) {
    out.millilitresPerCan = `No container here holds more than ${MAX_MILLILITRES_PER_CAN / 1000} L.`;
  }

  if (d.packingCostPaise != null && (!Number.isInteger(d.packingCostPaise) || d.packingCostPaise < 0)) {
    out.packingCostPaise = "A packing cost is zero or more.";
  } else if (d.packingKind === "loose" && d.packingCostPaise != null && d.packingCostPaise > 0) {
    out.packingCostPaise = "A loose can has no box, so it has no packing cost. Choose Drum if it is one.";
  }
  if (d.weightGrams != null && (!Number.isInteger(d.weightGrams) || d.weightGrams < 1)) {
    out.weightGrams = "A weight is more than zero, or blank.";
  }
  if (d.sellingPricePaise != null && (!Number.isInteger(d.sellingPricePaise) || d.sellingPricePaise < 1)) {
    out.sellingPricePaise = "A price is more than zero, or blank — a blank price is not a free product.";
  }
  if (d.externalCode != null && (!Number.isInteger(d.externalCode) || d.externalCode < 1)) {
    out.externalCode = "A legacy Product ID is a whole number.";
  }

  const seen = new Set<string>([matchKey(name)]);
  for (const a of d.aliases) {
    const clean = canonicalName(a);
    if (clean.length < 2) {
      out.aliases = "Each other name needs at least two characters.";
      break;
    }
    const key = matchKey(clean);
    if (seen.has(key)) {
      out.aliases = `"${clean}" is the SKU's own name or listed twice.`;
      break;
    }
    seen.add(key);
  }
  return out;
}
