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
 */
export const billCreditDaysSql = sql<number | null>`coalesce(
  (select o.credit_days
     from orders o
    where o.customer_id = bills.customer_id
      and o.credit_days is not null
      and (o.ordered_at at time zone 'Asia/Kolkata')::date <= bills.bill_date
    order by o.ordered_at desc
    limit 1),
  (select c.credit_days from customers c where c.id = bills.customer_id)
)`;
