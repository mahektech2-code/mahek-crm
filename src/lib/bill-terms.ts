import "server-only";
import { sql } from "drizzle-orm";

/* ---------------------------------------------------------------------------
 * The credit period in force for a bill.
 *
 * A bill that states its own due date needs none of this. Everything else
 * falls back in the order the business actually decides it: the term agreed on
 * the order that produced the bill, then the customer's standing term, then
 * the configured default — which the engine applies, not this fragment.
 *
 * Selected as a column rather than fetched per bill, because the follow-up
 * worklist reads every open bill in the book on every load.
 * ------------------------------------------------------------------------- */

/**
 * Every column of the OUTER table is written out in full. Drizzle renders
 * `${bills.customerId}` as a bare `"customer_id"`, which inside these
 * correlated subqueries would bind to `orders` instead and silently match
 * nothing. See AGENTS.md — this one shipped once.
 *
 * "Ordered on or before the bill's date, in India" is written as "ordered
 * before the Indian midnight that ends the bill's date" — the same rows, but a
 * test on the column itself rather than on a date worked out from it, so
 * `orders_customer_terms_idx` (0290) answers it newest-first and stops at the
 * first hit. As a cast it was a scan of the customer's whole order history per
 * bill: on the real book, 2 million buffer reads and about a second for every
 * screen and job that asks for every bill's term.
 */
export const billCreditDaysSql = sql<number | null>`coalesce(
  (select o.credit_days
     from orders o
    where o.customer_id = bills.customer_id
      and o.credit_days is not null
      and o.ordered_at < ((bills.bill_date + 1)::timestamp at time zone 'Asia/Kolkata')
    order by o.ordered_at desc
    limit 1),
  (select c.credit_days from customers c where c.id = bills.customer_id)
)`;
