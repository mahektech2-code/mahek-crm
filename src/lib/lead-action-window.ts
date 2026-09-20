/* ---------------------------------------------------------------------------
 * §24 — WHAT MAKES A NEXT ACTION DUE, AND WHAT MAKES ONE LATE.
 *
 * Two date windows, and they were written inside `lead-actions-service.ts`
 * because for a long time that file was the only thing that asked. It is not
 * any more: the summary strip above the leads list counts the same two
 * populations and offers a view of each, and a strip whose figures were
 * derived beside the screens they open is exactly the drift this codebase
 * argues against everywhere else — the tile says eleven, the screen lists
 * nine, and nothing on either says which is wrong.
 *
 * So the windows live here and both readers take them. Extracted rather than
 * copied: the park half of each is the kind of rule that gets added to one
 * copy and not the other, and it is invisible when it happens, because both
 * screens look right on their own.
 *
 * It imports drizzle and the ladder and nothing else — no database, no
 * `server-only` — so it sits below both services and neither has to import
 * the other. Two services that import each other to share one clause is a
 * cycle waiting for the day somebody adds a top-level read.
 *
 * `day` is the business date the CALLER already resolved. Never `now()` in
 * the statement: the working day is Asia/Kolkata and a bare cast reads in the
 * session's zone, which on a server running in GMT puts a Monday promise on
 * Sunday. Every comparison below is date-to-date, so there is no midnight to
 * name — the moment one of these columns becomes a timestamp,
 * `::timestamp at time zone 'Asia/Kolkata'` is the spelling, and the grep
 * tests will say so before anybody deploys it.
 * ------------------------------------------------------------------------- */

import { sql, type SQL } from "drizzle-orm";

import { TERMINAL_STAGES } from "./engines/lead-ladder";

/**
 * The rungs that are still the funnel's work, built from the engine rather
 * than typed out — a fifth terminal rung has to leave every queue in the
 * product on the same day, and a hand-typed list leaves exactly one behind.
 *
 * `::text` on the left rather than four enum literals on the right: the
 * parameters go down untyped, and comparing an enum against an untyped
 * parameter is a resolution Postgres usually gets right and is not obliged to.
 * The cast costs nothing here — it is a comparison, not a date.
 */
export const STILL_WORKING: SQL = sql`
  c.lead_stage is not null
    and c.lead_archived = false
    and c.lead_stage::text not in (${sql.join(
      TERMINAL_STAGES.map((s) => sql`${s}`),
      sql`, `,
    )})
`;

/**
 * A park read back — the other half of "owed", and the reason neither window
 * is one column.
 *
 * `on_hold` is a live prospect somebody deliberately stopped working until a
 * day they named, so the day arriving is as much a thing owed as a promise
 * falling due. The comparison is passed in because the two windows differ only
 * in it, and writing the park out twice is how the two come to disagree about
 * which day a hold comes back.
 */
function parkComesBack(cmp: SQL): SQL {
  return sql`(c.lead_stage = 'on_hold' and c.lead_hold_resume_date ${cmp})`;
}

/** What is owed TODAY. */
export function dueTodayWindow(day: string): SQL {
  return sql`(
    c.lead_next_action_date = ${day}::date
    or ${parkComesBack(sql`= ${day}::date`)}
  )`;
}

/**
 * Past its day, with nobody having said anything since.
 *
 * `lead_next_action_outcome is null` is the second half of that sentence and
 * it is what keeps the screen meaningful: a lead whose call was made and whose
 * answer was written down has been worked, whatever its date says.
 *
 * A park whose day has GONE is late in a way a promise is not: nobody has to
 * have recorded an outcome for it to still be waiting, because what was
 * promised was not a call — it was that somebody would look again. So the
 * `outcome is null` half deliberately does not apply to it.
 */
export function overdueWindow(day: string): SQL {
  return sql`(
    (c.lead_next_action_date < ${day}::date and c.lead_next_action_outcome is null)
    or ${parkComesBack(sql`< ${day}::date`)}
  )`;
}
