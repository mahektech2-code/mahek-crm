/**
 * Order quantities and what a line is worth.
 *
 * Both halves are **inherited from MahekOne**, not invented here. The CRM and
 * the handset write into the same book, and a rule that differs between them is
 * a rule that produces two figures for one order — which is noticed first by
 * the salesman, who then stops believing either screen. `lineValuePaise` and
 * `canValueOrders` below are ported from `src/lib/catalogue.ts` in the MahekOne
 * app (the `order valuation` section) and must stay in step with it.
 *
 * Pure. No prices are looked up, no clock is read.
 */

/* ---------------------------------------------------------------- quantity */

export type DerivedQuantities = {
  /** What the salesman counted and what the customer said. The stored figure. */
  cans: number;
  /** Whole boxes. Zero for a loose SKU or a drum, which is one container. */
  boxes: number;
  /** Cans not making up a whole box. Everything, where there is no box. */
  looseCans: number;
  /** Null where the pack size is unknown — not zero, which reads as "empty". */
  litres: number | null;
};

/**
 * Cans, boxes and litres from a quantity in cans.
 *
 * Cans are stored because cans are what is said out loud in the shop. Litres
 * are derived every single time they are shown: storing them instead would lose
 * "six cans" the moment a pack size changed, and pack sizes here run from half
 * a litre to two hundred and ten.
 */
export function derivedQuantities(
  cans: number,
  cansPerBox: number,
  millilitresPerCan: number | null,
): DerivedQuantities {
  const perBox = cansPerBox > 0 ? cansPerBox : 1;
  const boxes = perBox === 1 ? 0 : Math.floor(cans / perBox);
  const looseCans = perBox === 1 ? cans : cans % perBox;
  return {
    cans,
    boxes,
    looseCans,
    litres: millilitresPerCan == null ? null : (cans * millilitresPerCan) / 1000,
  };
}

/* ------------------------------------------------------- order valuation */

/**
 * Where a line's price is meant to come from. The catalogue document carries
 * no price at all, so this starts unanswered and the answer is a decision
 * somebody makes once — see `canValueOrders`.
 */
export type PriceSource = 'unset' | 'product' | 'pricelist' | 'manual';

/**
 * Whether a line's value may be computed at all.
 *
 * Until a price source is confirmed there is no honest way to value an order,
 * and the wrong way — reaching for the packing cost, because it is the only
 * number on the row — produces figures that look right on a target screen and
 * are not. So valuation asks first, and everything downstream of it says "not
 * yet" rather than showing a confident zero.
 */
export function canValueOrders(source: PriceSource): boolean {
  return source !== 'unset';
}

/**
 * A line's value in paise, or null when nothing may be computed yet.
 *
 * `manual` means the salesman typed the amount, so the typed figure stands and
 * the catalogue has no opinion. `product` reads the SKU's own price, which is
 * null until somebody sets it — and a null price is not a free product, so it
 * stays null rather than becoming zero.
 */
export function lineValuePaise(
  source: PriceSource,
  cans: number,
  sku: { sellingPricePaise: number | null },
  typedPaise: number | null,
): number | null {
  if (!canValueOrders(source)) return null;
  if (source === 'manual') return typedPaise;
  if (source === 'product') {
    return sku.sellingPricePaise == null ? null : cans * sku.sellingPricePaise;
  }
  // A customer price list is not built yet; until it is, nothing is claimed.
  return typedPaise;
}
