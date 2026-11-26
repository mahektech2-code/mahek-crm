/* ---------------------------------------------------------------------------
 * THE MONEY AN ORDER COMMITS, read on the phone — the pure half, no Expo
 * import, so `order-money.test.ts` runs it against the real handset schema.
 * `orders.ts` runs it.
 *
 * ORDERED, NOT YET INVOICED. The credit check adds what a billing party has
 * already ordered and not yet been billed for, or four orders each inside the
 * limit end the morning three lakh past it. The phone used to KEEP that figure
 * itself — `submittedNotInvoicedPaise += value` on every save, taken off only
 * on an edit or a cancel — so a billed order, a declined one and one the
 * office refused all went on counting for the life of the installation, and
 * the credit bar filled up and never emptied.
 *
 * It is the OFFICE's figure now (`openOrderedPaise` on the customers channel,
 * sent as `submittedNotInvoicedPaise`): open field and CRM orders billed to
 * this party, not yet on a bill. The phone adds only what the office cannot
 * know yet — orders whose CREATE is still in this outbox. Once the create has
 * gone the order is in the office's figure, and counting it here too would be
 * counting it twice; once it is refused it is in nobody's.
 * ------------------------------------------------------------------------- */

/**
 * What this phone has ordered for a billing party that the office has not
 * heard about. `?` 1 is the billing party, `?` 2 an order to leave out (the
 * one being edited, whose new value is the one being judged), or ''.
 */
export const UNSENT_ORDERS_PAISE_SQL = `SELECT COALESCE(SUM(COALESCE(o.netTotalPaise, 0)), 0) AS paise
       FROM orders o
      WHERE o.customerId = ? AND o.id <> ?
        AND o.status NOT IN ('cancelled','declined')
        AND EXISTS (SELECT 1 FROM sync_queue q
                     WHERE q.entityType = 'order' AND q.entityId = o.id AND q.op = 'create'
                       AND q.state NOT IN ('synced','rejected'))`;

/**
 * The open bills the overdue rule reads, for one billing party. Every open
 * bill is on the phone whatever its age (see `customerBills` on the server),
 * so the oldest debt — the one the rule is about — is never the one missing.
 */
export const OPEN_BILLS_FOR_GATES_SQL = `SELECT billNo, dueDate, balancePaise, paymentPosition, disputed
       FROM customer_bills
      WHERE customerId = ? AND COALESCE(balancePaise, 0) > 0`;

/**
 * Whether an order can still be taken back on this phone without asking
 * anybody: its create has not left (`queued`, `failed` or `blocked` behind
 * something else) — never while it is `syncing`, when it may be landing at the
 * office this second. Null where it cannot.
 */
export const UNSENT_CREATE_SQL = `SELECT id, state FROM sync_queue
      WHERE entityType = 'order' AND entityId = ? AND op = 'create'
        AND state IN ('queued','failed','blocked')
      LIMIT 1`;

/** Any outbox row still waiting on this order — an edit behind its create, say. */
export const ORDER_QUEUE_ROWS_SQL = `SELECT id FROM sync_queue
      WHERE entityType = 'order' AND entityId = ? AND state <> 'synced'`;

/**
 * His own orders for a shop that the office's list cannot have yet — taken on
 * this phone, create not yet accepted — billed to it OR delivered to it, for
 * the shop record's Orders tab. Shaped like `customer_orders` so one list can
 * draw both. `?` 1 and 2 are the shop.
 */
export const LOCAL_ORDERS_FOR_SHOP_SQL = `SELECT o.id, o.customerId, o.orderedAt AS orderedAtMs, o.status,
            o.netTotalPaise AS valuePaise,
            (SELECT COUNT(*) FROM order_lines ol WHERE ol.orderId = o.id) AS lines,
            o.orderNumber AS orderNo, o.syncState
       FROM orders o
      WHERE (o.customerId = ? OR o.deliveryCustomerId = ?)
        AND o.status NOT IN ('cancelled')
        AND COALESCE(o.syncState, '') <> 'synced'
      ORDER BY o.orderedAt DESC
      LIMIT 50`;

export type ShopOrderRow = {
  id: string;
  customerId: string;
  orderedAt: string | null;
  status: string | null;
  valuePaise: number | null;
  lines: number | null;
  orderNo: string | null;
  /** Set on a row this phone holds and the office has not accepted yet. */
  pending?: boolean;
};

/**
 * The office's orders for a shop with this phone's unsent ones laid over them,
 * newest first. An id on both is the office's copy — it has landed.
 */
export function mergeShopOrders(
  office: readonly ShopOrderRow[],
  local: readonly (Omit<ShopOrderRow, 'orderedAt' | 'pending'> & { orderedAtMs: number })[],
  toDay: (ms: number) => string,
): ShopOrderRow[] {
  const seen = new Set(office.map((o) => o.id));
  const mine: ShopOrderRow[] = local
    .filter((l) => !seen.has(l.id))
    .map((l) => ({
      id: l.id,
      customerId: l.customerId,
      orderedAt: toDay(l.orderedAtMs),
      status: l.status,
      valuePaise: l.valuePaise,
      lines: l.lines,
      orderNo: l.orderNo,
      pending: true,
    }));
  return [...mine, ...office].sort((a, b) => (b.orderedAt ?? '').localeCompare(a.orderedAt ?? ''));
}
