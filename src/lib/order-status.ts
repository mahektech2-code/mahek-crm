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
  /*
   * §N's two, and they count for the same reason `dispatched` does: goods on a
   * lorry are goods sold. An order that reached the customer must not stop
   * counting towards EOD value, the buying cycle, the product history and
   * outstanding merely because somebody recorded that it arrived.
   *
   * That is not a hypothetical: these were added to the enum and to this list
   * in one commit precisely because `orderCountsSql` below used to spell the
   * three statuses out as a literal. Adding a status to the array and not to
   * the string would have made every SQL read of "did we sell anything"
   * disagree with every TypeScript one — silently, and only for orders that
   * had got as far as being delivered.
   */
  "in_transit",
  "delivered",
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
  /*
   * DERIVED FROM THE LIST, never restated.
   *
   * This used to write the three statuses out as a literal beside an array
   * that held the same three, which is two definitions of "did we sell
   * anything" waiting to disagree. Adding `in_transit` and `delivered` is
   * exactly the change that would have split them — and the half that drifts
   * is the SQL, which is read by the eight money queries and checked by
   * nothing.
   *
   * The values are our own const array and not user input, so the quoting here
   * cannot be reached from outside; it is written out rather than parameterised
   * because this returns a raw fragment for use inside correlated subqueries.
   */
  const list = PURCHASE_STATUSES.map((s) => `'${s}'`).join(", ");
  return sql.raw(`${alias}.status in (${list})`);
}
