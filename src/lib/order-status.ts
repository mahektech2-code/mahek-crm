import { sql } from "drizzle-orm";

/* ---------------------------------------------------------------------------
 * When an order counts.
 *
 * An order taken on a call is not yet an order the business has agreed to.
 * Accounts check the customer before it is accepted, so between the call and
 * that decision it sits at `pending_approval`, and if they say no it ends at
 * `declined`.
 *
 * Two different questions get asked about the same row, and they have
 * different answers:
 *
 *   "Did the customer order?"  — yes, the moment the telecaller logged it.
 *     This drives the calling queue. Nobody should ring a customer tomorrow
 *     asking for an order they placed today, whatever accounts decide later.
 *     That signal is `customers.lastOrderDate`, set on capture.
 *
 *   "Did the business sell anything?" — only once approved. This drives
 *     money and history: EOD value, monthly targets, the buying cycle, the
 *     product history and the outstanding balance. A declined order must
 *     never have counted towards any of them.
 *
 * The second question is asked in eight places. Before this existed they all
 * said `status <> 'cancelled'`, which would have quietly counted every
 * pending and declined order — so it is declared once, here, and imported.
 * ------------------------------------------------------------------------- */

/** Statuses that represent a sale the business has agreed to. */
export const PURCHASE_STATUSES = [
  // Orders written before approval existed. They were accepted at the time
  // and retiring them into "pending" would rewrite history that already
  // settled.
  "captured",
  "confirmed",
  "dispatched",
] as const;

export const NON_PURCHASE_STATUSES = [
  "pending_approval",
  "declined",
  "cancelled",
] as const;

export function countsAsPurchase(status: string): boolean {
  return (PURCHASE_STATUSES as readonly string[]).includes(status);
}

/**
 * For raw SQL. Pass the table alias the query uses — `orderCountsSql("o")`
 * inside a join, `orderCountsSql("orders")` at the top level.
 *
 * Qualify the alias yourself: an unqualified `status` inside a correlated
 * subquery binds to the inner table, which is the bug the integration tests
 * exist to catch.
 */
export function orderCountsSql(alias: string) {
  return sql.raw(
    `${alias}.status in ('captured', 'confirmed', 'dispatched')`,
  );
}
