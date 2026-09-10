import { sql } from "drizzle-orm";

/* ---------------------------------------------------------------------------
 * WHOSE NUMBER IS IT.
 *
 * Every figure in the performance module — a rupee of revenue, a litre, a
 * receipt, a first order — belongs to exactly one person. This file is the
 * only place that decides which, and it is deliberately a different question
 * to the three that already live in `access-control.ts`.
 *
 *   `ASSIGNED_TO_SQL`  — whose BOOK an account is in. Falls back to `owner_id`.
 *   `scopedToUsers`    — whose LIST it appears on. Both seats, so one account
 *                        can reach two people, which is intended.
 *   `CREDITED_TO_SQL`  — whose SCORE it counts towards. Exactly one person.
 *
 * The difference between the second and the third is the whole reason this
 * file exists. Two people may both be responsible for an account and both need
 * to see it; only one of them may be credited with what it bought, or the
 * team's revenue adds up to more than the company's and every comparison
 * between two salesmen is drawn from a total that does not exist.
 *
 * ---------------------------------------------------------------------------
 *
 * THE RULE, which is Mahek's own and was stated as the one thing not to get
 * wrong:
 *
 *   A field salesman sells to the account   -> the salesman.
 *   Nobody does, but the back office does   -> the back office person.
 *   Neither                                 -> nobody. Reported, never hidden.
 *
 * It is a fall-through and not a split. A hundred percent lands on one person,
 * so the six figures on somebody's screen are the figures off real invoices —
 * half of an invoice is not a number anybody can check against a bill, and a
 * salesman who cannot check his own number does not believe it.
 *
 * WHY `owner_id` IS NOT IN THE CHAIN, though `ASSIGNED_TO_SQL` ends with it.
 *
 * `owner_id` on an imported customer is whoever ran the import — one person on
 * more than a thousand rows. Ending the chain there would hand that person the
 * revenue of the entire book on the day a target was set for them, and it is
 * the same trap the customer master already sprang once: an emptied sales seat
 * falling back to `owner_id` gave the importer accounts they had never sold to.
 * An unattributed customer is a fact worth surfacing; a wrongly attributed one
 * is a number somebody gets appraised on.
 *
 * A LEAD is the exception, and only because it has no sales seat to read: a
 * lead is worked by whoever owns it, which is what `ASSIGNED_TO_SQL` says
 * too. This matters for exactly one component — a lead placing its first order
 * is the new-customer event the acquisition target is counted from.
 * ------------------------------------------------------------------------- */

/**
 * For a query that has `customers` in scope by that name.
 *
 * Qualify the table, always: Drizzle renders a bare column, and inside a
 * correlated subquery a bare `sales_am_id` binds to the INNER table and the
 * condition silently becomes false. Types pass, unit tests pass, and the
 * number is wrong.
 */
export const CREDITED_TO_SQL = sql`
  case when customers.kind = 'lead'
       then customers.owner_id
       else coalesce(customers.sales_am_id, customers.back_office_am_id)
  end`;

/**
 * The SAME case, spelled out as which seat rather than whose id — for a
 * screen that shows the credited name and needs to say, next to it, whether
 * that is the salesperson or the back-office fallback. Kept beside
 * `CREDITED_TO_SQL` on purpose: one is read for the id, the other for the
 * label, and they must never be free to drift apart from each other.
 */
export const CREDITED_TO_SEAT_SQL = sql<CreditSeat>`case
  when customers.kind = 'lead' then
    case when customers.owner_id is not null then 'owner' else 'none' end
  when customers.sales_am_id is not null then 'sales'
  when customers.back_office_am_id is not null then 'back-office'
  else 'none'
end`;

/**
 * The same rule for raw SQL, where the table carries an alias.
 *
 * `creditedToSql("c")` inside a join, `creditedToSql("customers")` at the top
 * level. Two spellings of one rule is how the manager dashboard and the
 * handset come to disagree about the same salesman, so there are two
 * renderings of one string and no second definition.
 */
export function creditedToSql(alias: string) {
  return sql.raw(
    `case when ${alias}.kind = 'lead'
          then ${alias}.owner_id
          else coalesce(${alias}.sales_am_id, ${alias}.back_office_am_id)
     end`,
  );
}

/** The seat a customer's numbers were credited through — for saying so on screen. */
export type CreditSeat = "sales" | "back-office" | "owner" | "none";

export type CreditableCustomer = {
  kind: string;
  salesAmId: string | null;
  backOfficeAmId: string | null;
  ownerId: string | null;
};

/**
 * The TypeScript rendering, for anything already holding the row.
 *
 * It returns the seat as well as the person, because "why is this account on
 * my list" is a question somebody asks, and "it has no salesman, so it counts
 * to you as its back office" is an answer. A screen that shows the credit
 * without the seat leaves a telecaller to guess.
 */
export function creditedTo(customer: CreditableCustomer): {
  userId: string | null;
  seat: CreditSeat;
} {
  if (customer.kind === "lead") {
    return customer.ownerId
      ? { userId: customer.ownerId, seat: "owner" }
      : { userId: null, seat: "none" };
  }
  if (customer.salesAmId) return { userId: customer.salesAmId, seat: "sales" };
  if (customer.backOfficeAmId) {
    return { userId: customer.backOfficeAmId, seat: "back-office" };
  }
  return { userId: null, seat: "none" };
}

export const CREDIT_SEAT_LABELS: Record<CreditSeat, string> = {
  sales: "Salesperson",
  "back-office": "Back office — no salesperson on this account",
  owner: "Owner (lead)",
  none: "Unattributed",
};
