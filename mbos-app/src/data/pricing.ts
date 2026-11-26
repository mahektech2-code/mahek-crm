import { all, one } from '../db';

/**
 * `mbos_price_list`, read from the phone.
 *
 * Deliberately separate from `engines/order.ts`'s `lineValuePaise` and its
 * `PriceSource` — that pair is ported from MahekOne's own `products.priceSource`
 * switch and is a different decision by design (see the schema comment on
 * `mbosPriceList`: "switching the source has to be somebody's deliberate
 * act"). What lives here answers a narrower question a customer's own price
 * tag can answer today, whether or not that switch is ever flipped: what does
 * THIS account pay for THIS product, on the rate the office actually set.
 */

/** Every rate for one tag, keyed by product — one query for a whole cart. */
export async function ratesForTag(priceTag: string | null): Promise<Map<string, number>> {
  if (!priceTag) return new Map();
  const rows = await all<{ productId: string; ratePaise: number }>(
    'SELECT productId, ratePaise FROM price_list WHERE priceTag = ?',
    [priceTag],
  );
  return new Map(rows.map((r) => [r.productId, r.ratePaise]));
}

/**
 * THE KEY THIS SHOP'S RATES ARE FILED UNDER — its tag, unless the office said
 * otherwise. Shops sharing a tag but sitting on different office price lists
 * are pointed at `tag::list`, and an untagged shop a list resolves for at
 * `::list` (`customer_price_keys`, sent whole on every pull). Without it two
 * such shops got one rate on the phone and the office refused one of them
 * `price_changed` at sync.
 */
export async function priceKeyFor(customerId: string | null, priceTag: string | null): Promise<string | null> {
  if (customerId) {
    const row = await one<{ priceKey: string }>('SELECT priceKey FROM customer_price_keys WHERE customerId = ?', [customerId]);
    if (row?.priceKey) return row.priceKey;
  }
  return priceTag?.trim() ? priceTag : null;
}

/**
 * The products this shop's list prints a dash for — listed, and not sold to
 * it. The office refuses an order carrying one (`not_offered`), so the order
 * screen marks them and will not add them.
 */
export async function unofferedFor(priceKey: string | null): Promise<Set<string>> {
  if (!priceKey) return new Set();
  const rows = await all<{ productId: string }>('SELECT productId FROM price_unoffered WHERE priceKey = ?', [priceKey]);
  return new Set(rows.map((r) => r.productId));
}

export type ReorderLine = { productId: string; productName: string; cans: number };

/**
 * What he sold this account last time, as a starting cart.
 *
 * The most recent ORDER, not a running average — "the usual" is what
 * `frequentProducts` already answers, and reads differently: "add the three
 * things they buy most" is not the same offer as "put back what I sold them
 * on the last visit", which is what a salesman means by "reorder".
 */
export async function lastOrderLines(customerId: string): Promise<ReorderLine[]> {
  const last = await one<{ id: string }>(
    'SELECT id FROM orders WHERE customerId = ? ORDER BY orderedAt DESC LIMIT 1',
    [customerId],
  );
  if (!last) return [];
  return all<ReorderLine>(
    'SELECT productId, productName, cans FROM order_lines WHERE orderId = ? ORDER BY rowid ASC',
    [last.id],
  );
}
