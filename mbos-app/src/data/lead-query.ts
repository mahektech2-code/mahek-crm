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
  ALL_RUNGS,
  normaliseMobile,
  shiftDays,
  viewMatch,
  WHEN_WEEK_DAYS,
  type LeadView,
  type LeadWhen,
} from '../engines/leads';
import { isoDate } from '../lib/format';
import { foldStage } from '../engines/funnel/lead-ladder';
import type { LeadStage } from '../engines/funnel/lead-labels';

/* The stored words that fold to another rung, read off the mirrored engine's
   own `foldStage` rather than typed out again here. */
const FOLDS = ALL_RUNGS.map((w) => [w, foldStage(w as LeadStage)] as const).filter(([w, to]) => w !== to);

/** `funnelStage` read onto the one ladder, as SQL. No parameters. */
const FOLDED_RUNG = FOLDS.length
  ? `CASE funnelStage ${FOLDS.map(([w, to]) => `WHEN '${w}' THEN '${to}'`).join(' ')} ELSE funnelStage END`
  : 'funnelStage';

/** Every stored word that reads as this rung, itself included. */
function storedWordsFor(rung: string): string[] {
  return [rung, ...FOLDS.filter(([, to]) => to === rung).map(([w]) => w)];
}

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
    /* Sample received & review is stored as `sample_review`; the older
       `sample_received` is the same rung, so the chip answers for both. */
    /* Every stored word that FOLDS to the picked rung — `new` and `contacted`
       under Suspect, `qualified` under Qualification, the older
       `sample_received` under Sample received & review — because the chips
       are counted folded (`FOLDED_RUNG`) and a chip must find what it counts. */
    const words = storedWordsFor(filter.rung);
    parts.push(`funnelStage IN (${words.map(() => '?').join(', ')})`);
    args.push(...words);
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
  page?: { limit: number; offset: number },
): { sql: string; params: (string | number)[] } {
  const narrow = narrowing(filter);
  const search = searching(query);
  /* `id` ends the ordering for the reason it ends every paged ordering here:
     two leads owed on the same day, quiet since the same day, under the same
     name, are a tie the planner may break differently on the next page — and
     a tie on a page boundary is one lead twice and another not at all. */
  const order = ` ORDER BY ${OWED} IS NULL, ${OWED} ASC, lastActivityDate ASC, name, id`;
  return {
    sql:
      /* `pendingVisits` is what the outbox still holds for this shop: the
         card's visit counter used to read the office's figure alone, so a
         salesman who made his second visit with no signal saw "Visit 1 / 3" on
         the list while the visit screen, which adds the outbox, demanded the
         decision. One count, read the same way in both places. */
      `SELECT leads.*, (SELECT COUNT(*) FROM visits v WHERE v.customerId = leads.id AND v.syncState <> 'synced') AS pendingVisits` +
      ` FROM leads WHERE ${narrow.where}${search.where}${order}` +
      (page ? ' LIMIT ? OFFSET ?' : ''),
    params: [...narrow.args, ...search.args, ...(page ? [page.limit, page.offset] : [])],
  };
}

/**
 * A PAGE OF THE LEAD BOOK, and why it has one now.
 *
 * The book read every lead and handed the lot to the list. That was harmless
 * on a few hundred and is not on a territory where most of the shops are still
 * leads — the EMP master alone brought five thousand of them, each one a heavy
 * row of sixty columns held in memory before the first card was drawn. The
 * same size as a customers page, for the same reason.
 */
export const LEAD_PAGE = 30;

/** How many leads match — the number the screen prints, never a loaded length. */
export function leadCountQuery(
  filter: LeadBookFilter = {},
  query = '',
): { sql: string; params: string[] } {
  const narrow = narrowing(filter);
  const search = searching(query);
  return {
    sql: `SELECT COUNT(*) AS n FROM leads WHERE ${narrow.where}${search.where}`,
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
      /* Counted FOLDED, so a lead stored at a retired word (`new`,
         `qualified`, `sample_received`…) counts under the rung the record's
         ladder highlights rather than under a chip that names no rung. */
      `SELECT ${FOLDED_RUNG} AS rung, COUNT(*) AS count FROM leads` +
      ` WHERE ${narrow.where}${search.where} AND funnelStage IS NOT NULL` +
      ` GROUP BY rung ORDER BY count DESC, rung`,
    params: [...narrow.args, ...search.args],
  };
}

/**
 * A LEAD THAT HAS BECOME A CUSTOMER, asked of a `leads` row.
 *
 * The office's own definition is `notConverted` in MahekOne's
 * `lib/lead-action-window.ts`, and this is the same four facts read off what
 * the phone holds: the ledger calling the shop a customer (`customers.kind`,
 * which arrives on every pull), a winning terminal rung, the legacy word for
 * one, and the third-party mark on either table. A lead the office converted
 * stops arriving on the leads channel, so its row here is frozen at whatever
 * it last was — which is why the customer row, the one the office keeps
 * current, is asked as well as the lead's own.
 *
 * A bare clause over `leads` with no parameters, so it can be spliced into a
 * DELETE and run against a real SQLite in `leads-query.test.ts`.
 */
export const CONVERTED_LEAD = `(${leadRowConverted('leads')}
    OR EXISTS (SELECT 1 FROM customers c WHERE c.id = leads.id AND ${customerRowSettled('c')}))`;

/**
 * THE ONE RULE FOR "IS THIS STILL A LEAD", in its two halves.
 *
 * It used to be stated twice and the two disagreed: the Customers chips
 * (`IS_LEAD` in `customer-query.ts`) left out only `won` / `Converted`, while
 * the reconcile (`CONVERTED_LEAD` above) also read `customer`,
 * `active_distributor` and the third-party mark — so a shop could be "a lead"
 * on the chip and "converted" to the sweep that was about to delete its row.
 * Both now build from these two clauses, and `isLiveLead` in
 * `lib/account-label.ts` is the same rule in JavaScript for the record screen.
 *
 * `leadRowConverted` — what the lead's OWN row says: a winning terminal rung,
 * the legacy word for one, or the third-party mark.
 */
export function leadRowConverted(alias: string): string {
  return `(COALESCE(${alias}.thirdParty, 0) = 1
    OR COALESCE(${alias}.funnelStage, '') IN ('won', 'customer', 'active_distributor')
    OR COALESCE(${alias}.stage, '') = 'Converted')`;
}

/** What the CUSTOMER row says: the office invoices it, or it is a third party. */
export function customerRowSettled(alias: string): string {
  return `(COALESCE(${alias}.thirdParty, 0) = 1 OR COALESCE(${alias}.kind, '') = 'customer')`;
}

/**
 * A `customers` row that is a LEAD — the Customers view's Leads chip, the
 * card's "Lead" word and the tap that opens `/lead` all read this.
 *
 * Not third party and not invoiced (the mark and the ledger win, as on the
 * office's lists), and then EITHER a live, unconverted lead row OR, where the
 * phone holds no lead row at all, the office's own `kind = 'lead'`. That second
 * arm is the shop the office calls a lead whose lead row has not reached this
 * phone (another owner's lead in his territory, or a row the sweep released):
 * it IS a lead, so it is counted and labelled as one, and it opens `/customer`
 * because there is no ladder here to open. An ARCHIVED lead row means the lead
 * was filed away, so its shop is listed under Customers, as before.
 *
 * NOTE: a lead row with no customers row at all cannot appear on this list —
 * there is nothing to draw it from — so the Leads TAB can count a lead the
 * Customers "Leads" chip does not. That is the one gap left between the two.
 */
/**
 * A `customers` row whose lead was FILED AWAY on this phone — the lead row is
 * here, archived (the office's tombstone for a lead lost, trashed or filed),
 * and nothing says it converted.
 *
 * It is not a live lead, so `leadCustomerClause` leaves it out and it is
 * listed under Customers — where it used to open `/customer`, a page of empty
 * ledgers about a shop nobody bills, while the duplicate check called the same
 * shop "a lead". One rule now, read by the list, Nearby and the duplicate
 * check: it is a "Lost / filed lead", and a tap opens the lead record, where
 * its history is and where it can be brought back.
 */
export function filedLeadClause(alias = 'customers'): string {
  return `(NOT ${customerRowSettled(alias)}
    AND EXISTS (SELECT 1 FROM leads l WHERE l.id = ${alias}.id AND l.archived = 1
                  AND NOT ${leadRowConverted('l')}))`;
}

/**
 * THE DUPLICATE CHECK'S TWO HALVES, on the list's own rule. A customers row is
 * a lead where `leadCustomerClause` says so OR it is a filed lead; the leads
 * half asks every lead row not converted, archived or not — a shop already
 * lost is still a shop somebody worked, and raising it again as new loses
 * that history.
 */
export const DUPLICATE_CUSTOMERS_SQL = `SELECT id, name, phone,
    (${leadCustomerClause('customers')} OR ${filedLeadClause('customers')}) AS isLead,
    ${filedLeadClause('customers')} AS isFiled
  FROM customers WHERE phone IS NOT NULL`;

export const DUPLICATE_LEADS_SQL = `SELECT id, name, mobile, archived AS isFiled
  FROM leads WHERE mobile IS NOT NULL AND NOT ${leadRowConverted('leads')}`;

export function leadCustomerClause(alias = 'customers'): string {
  return `(NOT ${customerRowSettled(alias)}
    AND (EXISTS (SELECT 1 FROM leads l WHERE l.id = ${alias}.id AND l.archived = 0
                   AND NOT ${leadRowConverted('l')})
         OR (COALESCE(${alias}.kind, '') = 'lead'
             AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = ${alias}.id))))`;
}
