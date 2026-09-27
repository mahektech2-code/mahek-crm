import { sql } from "drizzle-orm";

/* ---------------------------------------------------------------------------
 * "MONEY THAT ARRIVED" — one definition, read by every figure headed
 * Collected, money in, or confirmed this month.
 *
 * A confirmed receipt, and never paperwork. Two modes settle bills without a
 * rupee reaching the bank: `Adjustment` (set against something already on the
 * account) and `Credit note` (goods returned or a claim allowed), and a credit
 * note issued from a complaint is also written as a receipt keyed
 * `creditnote:<complaint>`. Counting either as collected is a figure somebody
 * reconciles against the bank statement and finds short — on the real book in
 * August 2026 that was ₹5.74 L of credit notes read as money in.
 *
 * Before this, four screens answered the question three ways: Money left
 * credit notes out, while Company, Targets and the Accounts home counted the
 * `Credit note` mode in, so one month's Collected moved by a different
 * percentage on two screens of the same dashboard.
 * ------------------------------------------------------------------------- */
export function moneyArrivingSql(alias: string) {
  return sql.raw(
    `(${alias}.status = 'confirmed'
      and ${alias}.mode not in ('Adjustment', 'Credit note')
      and coalesce(${alias}.idempotency_key, '') not like 'creditnote:%')`,
  );
}
