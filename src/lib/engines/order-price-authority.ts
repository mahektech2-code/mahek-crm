/**
 * WHO DECIDES WHAT A LINE ON AN ORDER COSTS — pure, and read by every door an
 * order comes in through.
 *
 * Two questions, asked of the same row:
 *
 *  - A FIELD ORDER (`handleOrder`, the handset) quotes a rate per can. The
 *    office is the authority on that rate: the price list Accounts resolve for
 *    the customer on the order's date, and the handset's tag table only where
 *    no list carries the product. `judgeFieldOrderPrices` says whether every
 *    quoted line agrees, whatever the payload claims its price basis was —
 *    the payload's `priceTag` is not consulted at all, because a check that
 *    runs only when the caller asks for it is not a check.
 *
 *  - A DESK ORDER (the ERP order form) may carry a discount and a typed rate.
 *    `lineAuthority` turns both into ONE effective discount against the list
 *    rate and hands it to `discountAuthority` — the same function the CRM's
 *    call panel already asks — so a rate typed ₹10 under the list is a ₹10
 *    discount, and it needs the same authority a discount would.
 */
import { discountAuthority, type DiscountLevel } from "./price-math";

const BP = 10_000;

/* -------------------------------------------------------- the field order */

/** What the office says one product costs this customer, per can, on the order's date. */
export type OfficeRate = {
  /** Per can, the figure a handset line is in (GST included for a list rate). */
  ratePaise: number;
  /** Where the figure came from: a resolved price list, or the handset's tag table. */
  source: "list" | "tag";
  /** The list's name, or the tag, for the sentence a refusal prints. */
  basis: string;
  /** False where the list prints a dash: listed, and not for sale. */
  offered: boolean;
};

export type FieldLine = { productId: string; quantityCans: number; ratePaise?: number | null };

export type FieldPriceVerdict =
  | { ok: true }
  | {
      ok: false;
      code: "price_changed" | "not_offered" | "total_mismatch";
      productId: string | null;
      quotedPaise: number | null;
      officePaise: number | null;
      basis: string | null;
    };

/**
 * Every line, checked against the office.
 *
 * - A line the handset quoted a rate for, where the office has one, must quote
 *   exactly that rate.
 * - A line the office lists with a dash cannot be sold at any rate.
 * - A line the office has no rate for at all keeps what was quoted: that is a
 *   rate typed where nobody has published one (`products.priceSource = manual`).
 * - A line with no rate is the handset saying it could not value it, which the
 *   order already carries as `valueUnavailable`; there is nothing to compare.
 * - Where every line is rated and the order claims a value, that value may not
 *   exceed what its lines add up to. It may fall below them — a scheme the
 *   handset applied takes money off the total and not off a line — and that
 *   is for accounts' approval to read, not for this to guess at.
 */
export function judgeFieldOrderPrices(
  lines: readonly FieldLine[],
  office: ReadonlyMap<string, OfficeRate>,
  order: { totalAmountPaise: number; valueUnavailable: boolean },
): FieldPriceVerdict {
  for (const line of lines) {
    const rate = office.get(line.productId);
    if (!rate) continue;
    if (!rate.offered) {
      return { ok: false, code: "not_offered", productId: line.productId, quotedPaise: line.ratePaise ?? null, officePaise: null, basis: rate.basis };
    }
    if (line.ratePaise != null && line.ratePaise !== rate.ratePaise) {
      return { ok: false, code: "price_changed", productId: line.productId, quotedPaise: line.ratePaise, officePaise: rate.ratePaise, basis: rate.basis };
    }
  }
  const allRated = lines.length > 0 && lines.every((l) => l.ratePaise != null);
  if (allRated && !order.valueUnavailable && order.totalAmountPaise > 0) {
    const sum = lines.reduce((a, l) => a + (l.ratePaise ?? 0) * l.quantityCans, 0);
    if (order.totalAmountPaise > sum) {
      return { ok: false, code: "total_mismatch", productId: null, quotedPaise: order.totalAmountPaise, officePaise: sum, basis: null };
    }
  }
  return { ok: true };
}

/**
 * The list a field order was priced from, for `orders.price_list_id`: the one
 * list every list-priced line came from, or null where none did. Two lists on
 * one order cannot be named by one column, and naming either would be wrong.
 */
export function pricedFromList(
  lines: readonly FieldLine[],
  office: ReadonlyMap<string, OfficeRate & { listId?: string | null }>,
): string | null {
  const ids = new Set<string>();
  for (const l of lines) {
    const r = office.get(l.productId);
    if (r?.source === "list" && r.listId) ids.add(r.listId);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

/* ---------------------------------------------------------- the desk order */

/**
 * A typed rate and a discount, as ONE discount off the list rate, in basis
 * points: 1 − (rate ÷ list) × (1 − discount). A rate above the list is not a
 * negative discount — it is never allowed to buy back room for a discount —
 * so the rate's part stops at zero. With no list rate there is nothing to
 * measure a typed rate against, and only the discount counts.
 */
export function effectiveDiscountBp(input: {
  listRatePaise: number | null;
  ratePaise: number | null;
  discountBp: number | null;
}): number {
  const d = Math.max(0, input.discountBp ?? 0);
  const list = input.listRatePaise;
  if (list == null || list <= 0 || input.ratePaise == null) return d;
  const rateShare = Math.min(1, input.ratePaise / list);
  return Math.max(0, Math.round(BP - rateShare * (BP - d)));
}

export type LineAuthority = {
  allowed: boolean;
  reason: string | null;
  /** The discount the line amounts to, rate and discount together. */
  effectiveBp: number;
  /** A typed rate that is not the list's — recorded with who set it. */
  rateOverridden: boolean;
  /** Above what an associate may give alone, so whoever saved it authorised it. */
  needsAuthority: boolean;
  /** What this person may give on their own. */
  maxBp: number;
};

/**
 * May this person save this line as it stands?
 *
 * The ceiling is `discountAuthority`'s, unchanged — associate, manager, admin
 * — so the ERP and the CRM cannot answer one discount two ways.
 */
export function lineAuthority(
  input: { listRatePaise: number | null; ratePaise: number | null; discountBp: number | null },
  level: DiscountLevel,
  ceilings: { associateMaxBp: number; managerMaxBp: number },
): LineAuthority {
  const rateOverridden = input.ratePaise != null && input.ratePaise !== input.listRatePaise;
  if (input.discountBp != null && (input.discountBp < 0 || input.discountBp > BP)) {
    return { allowed: false, reason: "Discount must be between 0 and 100", effectiveBp: 0, rateOverridden, needsAuthority: false, maxBp: 0 };
  }
  const effectiveBp = effectiveDiscountBp(input);
  const verdict = discountAuthority(effectiveBp, level, ceilings);
  const viaRate = rateOverridden && input.listRatePaise != null && (input.ratePaise ?? 0) < input.listRatePaise;
  return {
    allowed: verdict.allowed,
    reason: verdict.allowed
      ? null
      : viaRate
        ? `This rate is ${pct(effectiveBp)} under the list${input.discountBp ? " with the discount" : ""}. ${verdict.reason}`
        : verdict.reason,
    effectiveBp,
    rateOverridden,
    needsAuthority: effectiveBp > ceilings.associateMaxBp,
    maxBp: verdict.maxBp,
  };
}

function pct(bp: number): string {
  const p = bp / 100;
  return `${Number.isInteger(p) ? p : p.toFixed(2)}%`;
}

/* ---------------------------------------------------- the handset's table */

export type TagRate = { priceTag: string; productId: string; ratePaise: number };

/**
 * The handset's `price_list`, with the office's rates laid over the tags the
 * office can speak for. One row per (tag, product) — the handset's own primary
 * key, which a tag table carrying two rates in force for one product would
 * otherwise break on insert — the first row winning, which the query orders
 * newest first. For a tag in `office`, a product the list carries takes the
 * list's rate, and a product the list prints a dash for is dropped, so the
 * phone cannot quote what the order check would refuse.
 */
export function mergeOfficeRatesIntoTags(
  tagRows: readonly TagRate[],
  office: ReadonlyMap<string, ReadonlyMap<string, number | null>>,
): TagRate[] {
  const out = new Map<string, TagRate>();
  for (const r of tagRows) {
    const key = `${r.priceTag}\u0000${r.productId}`;
    if (out.has(key)) continue;
    if (office.get(r.priceTag)?.has(r.productId)) continue;
    out.set(key, { priceTag: r.priceTag, productId: r.productId, ratePaise: Number(r.ratePaise) });
  }
  for (const [priceTag, rates] of office) {
    for (const [productId, ratePaise] of rates) {
      if (ratePaise == null) continue;
      out.set(`${priceTag}\u0000${productId}`, { priceTag, productId, ratePaise });
    }
  }
  return [...out.values()].sort((a, b) => (a.priceTag === b.priceTag ? a.productId.localeCompare(b.productId) : a.priceTag.localeCompare(b.priceTag)));
}
