/* ---------------------------------------------------------------------------
 * The lead book's reads, as statements rather than as queries already run.
 *
 * It is the shape `customer-query.ts` next door takes, and for its reason: this
 * file imports the database not at all, so every statement in it can be put
 * through a real SQLite carrying the real schema in an ordinary node test.
 * `data/leads.ts` imports expo-sqlite and cannot be loaded outside a handset,
 * which means a query written there is a query nobody can execute until it is
 * on somebody's phone. `buildPull` was exactly that: correct-looking, wrong,
 * and unexercised, twice running.
 * ------------------------------------------------------------------------- */

import {
  normaliseMobile,
  shiftDays,
  viewMatch,
  WHEN_WEEK_DAYS,
  type LeadView,
  type LeadWhen,
} from '../engines/leads';
import { isoDate } from '../lib/format';

/**
 * What the book can be cut by.
 *
 * All optional and all ANDed: a view, one rung inside it, and what is owed. The
 * screen holds them as one object rather than three arguments so a caller that
 * wants the whole open book passes nothing and reads the same way it always
 * did.
 */
export type LeadBookFilter = {
  view?: LeadView;
  /** One rung inside the picked view. Ignored by `all` and `archived`. */
  rung?: string | null;
  when?: LeadWhen;
  /** The business date the caller already resolved. Never the clock in render. */
  today?: string;
};

/**
 * THE EARLIEST DAY THIS LEAD NEXT WANTS HIM, as one expression.
 *
 * §24's next action, the salesman's own diary, and — only where the lead is
 * actually parked — the day a hold was promised to come back. `leadOwed` in the
 * engine is the same three in the same order, and this is what the chips cut by
 * AND what the list sorts by, so the chip that catches a row, the place the sort
 * puts it and the sentence under its name cannot disagree. See `LEAD_WHENS` for
 * why it is three columns rather than one.
 *
 * SQLite's `min(a, b, c)` answers NULL if ANY argument is, which is the opposite
 * of what is wanted: a lead with an action and no promise is owed on the action.
 * So each arm is floored at a day nothing can reach and the floor is read back
 * off with `NULLIF` — a lead owing nothing anywhere answers NULL, which is what
 * "Nothing promised" selects on and what sorts to the bottom.
 *
 * `nextActionOutcome` is NOT read. It is §24's fourth answer — what somebody is
 * expected to come back with, written when the action is set — and reading it as
 * a record of what happened is what emptied MahekOne's own Overdue screen.
 */
const NEVER = "'9999-12-31'";
const PARKED = `(funnelStage = 'on_hold' OR (funnelStage IS NULL AND stage = 'On hold'))`;
const OWED = `NULLIF(MIN(
  COALESCE(nextActionDate, ${NEVER}),
  COALESCE(nextFollowUpDate, ${NEVER}),
  COALESCE(CASE WHEN ${PARKED} THEN holdResumeDate END, ${NEVER})
), ${NEVER})`;

/** The narrowing, as SQL and its arguments. Built once, used by both reads. */
function narrowing(filter: LeadBookFilter): { where: string; args: string[] } {
  const view = filter.view ?? 'all';
  const parts: string[] = [view === 'archived' ? 'archived = 1' : 'archived = 0'];
  const args: string[] = [];

  /*
   * THE ROW SPEAKS ONE OF TWO VOCABULARIES, AND BOTH ARMS ARE LOAD BEARING.
   *
   * `funnelStage` is the specification's rung and is what the office sends;
   * `stage` is the six-word column this app shipped with, and it is all a lead
   * raised on this handset before the funnel — or pulled by a build older than
   * these columns — has ever carried. Selecting on the rung alone would empty
   * every chip of the old book on the day this ships, which is the one outcome
   * a change to a filter must not have: the leads would still be there, on no
   * chip, findable only on All.
   */
  const match = viewMatch(view);
  if (match) {
    const rungs = match.rungs.map(() => '?').join(', ');
    const legacy = match.legacy.map(() => '?').join(', ');
    parts.push(
      `((funnelStage IS NOT NULL AND funnelStage IN (${rungs}))` +
        ` OR (funnelStage IS NULL AND stage IN (${legacy})))`,
    );
    args.push(...match.rungs, ...match.legacy);
  }

  /* One rung inside the band, and only where the band has one to pick. The
     sub-chips are built from what is in the book, so this can only ever name a
     rung something is standing on. */
  if (filter.rung && match) {
    parts.push('funnelStage = ?');
    args.push(filter.rung);
  }

  /*
   * What is owed, on the earliest of the three days — see `OWED` above and
   * `LEAD_WHENS` in the engine for why it is three and not one. The comparisons
   * are date-to-date on ISO strings, which sort correctly as text, so there is
   * no midnight to name and no zone to lose: the day came from the caller, who
   * resolved it against Asia/Kolkata already.
   */
  /* The caller's own business date wherever there is one — every screen here
     reads the clock once and passes it down, because reading it per render is
     impure and reading it per query would put two different "todays" on one
     list. The fallback is the handset's own day, which is the salesman's: the
     device is in Asia/Kolkata and `isoDate` reads it there. */
  const today = filter.today ?? isoDate(new Date());
  switch (filter.when ?? 'any') {
    case 'overdue':
      parts.push(`${OWED} < ?`);
      args.push(today);
      break;
    case 'today':
      parts.push(`${OWED} = ?`);
      args.push(today);
      break;
    case 'week':
      parts.push(`${OWED} > ? AND ${OWED} <= ?`);
      args.push(today, shiftDays(today, WHEN_WEEK_DAYS));
      break;
    case 'none':
      parts.push(`${OWED} IS NULL`);
      break;
    default:
      break;
  }

  return { where: parts.join(' AND '), args };
}

/**
 * The search, in SQLite rather than over the rows already on the screen.
 *
 * The reason the customers list gives: finding one named shop meant scrolling
 * past all of them. It reaches the shop name, the person, the number and the
 * town, because that is whichever one he has been given. The number is matched
 * as typed AND stripped, so a lead stored as `9822011001` is still found by
 * somebody who types `98220 11001`.
 */
function searching(query: string): { where: string; args: string[] } {
  const q = query.trim();
  if (!q) return { where: '', args: [] };
  const like = `%${q}%`;
  const digits = normaliseMobile(q);
  const wide = digits.length >= 4;
  return {
    where: ` AND (name LIKE ? OR company LIKE ? OR city LIKE ? OR mobile LIKE ?${wide ? ' OR mobile LIKE ?' : ''})`,
    args: wide ? [like, like, like, like, `%${digits}%`] : [like, like, like, like],
  };
}

/**
 * The list, in the order the work should be done.
 *
 * A promised follow-up comes first and the ones with no date sit under them —
 * a lead nobody has promised anything is still a lead, and sorting it off the
 * bottom of the screen is how it stops existing.
 *
 * IT SELECTS ON `funnelStage` NOW, not on the six-word column. That column is
 * still written and still read — by `leadAlert`, by the visit cap and by every
 * lead carrying no rung at all — but it can only say one of seven things about
 * a lead standing on one of twenty-three rungs, so a salesman could not ask for
 * his sample trials or his negotiations. See `viewMatch` in the engine for how
 * the two vocabularies are narrowed together.
 */
/**
 * The list, in the order the work should be done.
 *
 * A promised follow-up comes first and the ones with no date sit under them —
 * a lead nobody has promised anything is still a lead, and sorting it off the
 * bottom of the screen is how it stops existing.
 *
 * IT SELECTS ON `funnelStage` NOW, not on the six-word column. That column is
 * still written and still read — by `leadAlert`, by the visit cap and by every
 * lead carrying no rung at all — but it can only say one of seven things about
 * a lead standing on one of twenty-three rungs, so a salesman could not ask for
 * his sample trials or his negotiations. See `viewMatch` in the engine for how
 * the two vocabularies are narrowed together.
 *
 * THE STATEMENT IS BUILT BY A FUNCTION THAT RETURNS IT, and that is the whole
 * reason for the shape — the same shape `data/customer-query.ts` next door
 * takes. A query nothing can execute outside a handset is a query nobody can
 * check: `buildPull` was correct-looking, wrong, and unexercised for two bugs
 * running. This one is run against real SQLite in `leads-query.test.ts`.
 */
export function leadBookQuery(
  filter: LeadBookFilter = {},
  query = '',
): { sql: string; params: string[] } {
  const narrow = narrowing(filter);
  const search = searching(query);
  return {
    sql:
      `SELECT * FROM leads WHERE ${narrow.where}${search.where}` +
      ` ORDER BY ${OWED} IS NULL, ${OWED} ASC, lastActivityDate ASC, name`,
    params: [...narrow.args, ...search.args],
  };
}


/**
 * The rungs actually standing in the book under the picked view, biggest first.
 *
 * DERIVED FROM THE ROWS RATHER THAN FROM THE LADDER, which is the whole point:
 * the ladder says which rungs can exist and this says which ones do. A salesman
 * who sells to shops has no `management_review` lead and never will, and a chip
 * offering him one is a chip that answers nothing when he presses it. It is
 * also what keeps the second row SHORT — a band holds two or three rungs on a
 * real book, and where it holds one the screen draws nothing, because a single
 * option is not a choice.
 *
 * A row carrying no `funnelStage` contributes nothing here: its rung is the
 * view it is already under, so offering it would be offering the chip above.
 */
export function rungCountsQuery(
  filter: LeadBookFilter,
  query = '',
): { sql: string; params: string[] } | null {
  if (!viewMatch(filter.view ?? 'all')) return null;
  /* The rung itself is deliberately dropped: the counts have to describe the
     whole band, or picking one rung would leave the others reading zero. */
  const narrow = narrowing({ ...filter, rung: null });
  const search = searching(query);
  return {
    sql:
      `SELECT funnelStage AS rung, COUNT(*) AS count FROM leads` +
      ` WHERE ${narrow.where}${search.where} AND funnelStage IS NOT NULL` +
      ` GROUP BY funnelStage ORDER BY count DESC, rung`,
    params: [...narrow.args, ...search.args],
  };
}

