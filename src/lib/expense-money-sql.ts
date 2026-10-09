import { sql, type SQL } from "drizzle-orm";

/**
 * WHAT ONE EXPENSE LINE IS, AND WHAT IT IS WORTH — the one SQL statement of it.
 *
 * Two kinds of line share `mbos_expenses`:
 *
 *  - An ALLOWANCE is written by the office from the day's records — the meal
 *    allowance off his punch-in and punch-out (`source_type = 'expense_day'`),
 *    the kilometre allowance on a trip by his own bike or car
 *    (`source_type = 'travel_leg'`). It is his by right of the work log, so it
 *    needs nobody's approval and counts as soon as it exists.
 *  - An EXPENSE is something he logged himself — a hotel, a food bill, a fare
 *    (`source_type` 'manual', or null on rows older than the column). Each one
 *    carries its own `expense_claim` approval and counts only once his manager
 *    has said yes, for the amount the manager allowed.
 *
 * Every screen that adds money up reads these three functions rather than
 * spelling the rule out again: the Expenses desk, the salary screen, the
 * handset's own list and the expense ROI report. A second spelling is how one
 * screen pays a meal allowance another one is still waiting to approve.
 *
 * `e` is the alias the caller gave `mbos_expenses`.
 */
export function isAllowanceSql(e: string): SQL {
  const a = sql.raw(e);
  return sql`(coalesce(${a}.source_type, 'manual') in ('travel_leg', 'expense_day'))`;
}

/**
 * The line's own approval, newest step first. Only `subject_type = 'expense'`
 * is read: the per-DAY approvals the module used to raise decided days, not
 * lines, and no line he logged ever depended on one alone.
 */
function ownApproval(e: string, column: string): SQL {
  const a = sql.raw(e);
  return sql`(select ap.${sql.raw(column)} from mbos_approvals ap
               where ap.subject_type = 'expense' and ap.subject_id = ${a}.id
               order by ap.step_index desc, ap.requested_at desc limit 1)`;
}

/**
 * `allowance`, `pending`, `approved`, `partially_approved` or `rejected`.
 *
 * A logged expense with no approval row yet is `pending`: the handset raises
 * the approval as its own record right behind the expense, and for the few
 * seconds between the two it is waiting on exactly the same person.
 */
export function expenseStateSql(e: string): SQL {
  return sql`(case when ${isAllowanceSql(e)} then 'allowance'
                   else coalesce(${ownApproval(e, "state")}::text, 'pending') end)`;
}

/**
 * What the line is worth once decided, in paise; 0 while it is waiting or
 * after it was refused. An allowance is worth its amount. A part-approved
 * expense is worth what the manager allowed, never what was asked.
 */
export function paidPaiseSql(e: string): SQL {
  const a = sql.raw(e);
  return sql`(case
      when ${isAllowanceSql(e)} then ${a}.amount_paise
      when ${ownApproval(e, "state")} in ('approved', 'partially_approved')
        then coalesce(${ownApproval(e, "approved_amount_paise")}, ${a}.amount_paise)
      else 0 end)`;
}

/** What the manager allowed on a part-approved expense; null otherwise. */
export function approvedAmountSql(e: string): SQL {
  return ownApproval(e, "approved_amount_paise");
}

/** The decision note on a logged expense — the reason, where it was refused. */
export function decisionNoteSql(e: string): SQL {
  return ownApproval(e, "decision_note");
}
