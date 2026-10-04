/**
 * The book's reads, as SQL and nothing else.
 *
 * Pure on purpose. Everything below builds a string and a parameter list and
 * touches no database, which is what makes it testable against a real SQLite
 * without a handset — and this is exactly the code that needs it. A distance
 * ordering is arithmetic with six repeated parameters in it; whether they are
 * bound in the right order is not a thing anybody can see by reading, and
 * getting it wrong sorts the book by nonsense rather than failing.
 *
 * The same reasoning `lib/wire.ts` gives for living where it does: a mapping
 * written inline in the call site needs a device to exercise, so it never is.
 */

import { isoDate } from '../lib/format';

/**
 * A PAGE OF THE BOOK IS FIFTEEN SHOPS, however big the territory is.
 *
 * The list used to read every row and render every one, and it survived only
 * because the book was empty — the pull had never once landed, so every
 * handset had nothing to draw. The first sync that worked put two thousand
 * rows on a phone, the screen built two thousand cards on the JS thread, and
 * Android offered to close the app.
 *
 * One constant, so the first read, the next page and the sentence counting
 * them cannot disagree.
 *
 * THIRTY, NOT FIFTEEN, because the list now asks for the next page by itself
 * as he nears the bottom rather than behind a button. A page is what a quick
 * flick scrolls past; at fifteen the second request fired before the first
 * screenful had settled, and a cheaper card means thirty is still less work on
 * the JS thread than fifteen of the old six-button ones were.
 */
export const CUSTOMER_PAGE = 30;

/** Where to measure from: a fix, a city's centre, or nothing. */
export type Origin = { lat: number; lng: number } | null;

/**
 * Which half of the book to show.
 *
 * A LEAD IS A ROW IN BOTH TABLES on this handset. The office collapsed the two
 * into one `customers` row long ago — `kind` and `lead_stage` live there — but
 * the wire still sends leads down their own channel into `leads`, keyed on the
 * same id. So "is this a lead" is asked as an EXISTS against that table rather
 * than read off a column the handset does not have.
 *
 * `archived = 0` matters: an archived lead is one filed out of the way, and it
 * should not make its customer row disappear from the Customers view.
 */
export type BookView = 'all' | 'customers' | 'leads';

/*
 * AND A LEAD THAT HAS ORDERED IS NOT ONE ANY MORE. The ladder keeps its
 * `first_order`, `second_order` and `customer` rungs after the office flips
 * `kind` to `customer`, and a lead the office moved to won stops arriving and
 * stays frozen here at its last rung. Reading the EXISTS alone listed a billed
 * customer only under Leads — missing from Customers, its chips and its counts
 * — with an Account tab saying "nothing billed to a lead". The office's `kind`
 * is the ledger's statement about the account, so it wins; a null `kind` (an
 * older payload) keeps the old reading.
 */
const IS_LEAD = `(EXISTS (SELECT 1 FROM leads l WHERE l.id = customers.id AND l.archived = 0
      AND COALESCE(l.funnelStage, '') <> 'won' AND COALESCE(l.stage, '') <> 'Converted')
    AND COALESCE(customers.kind, 'lead') <> 'customer')`;

/**
 * WHAT THE CARD NEEDS TO SAY WHAT A ROW IS, added to the projection of both
 * pages below.
 *
 * The list used to select `customers.*` and nothing else, which meant the card
 * could name the account's KIND and never its RUNG — a lead sat in the book
 * reading "Lead", or on a row whose `kind` had never been filled in, reading
 * nothing at all. Suspect, Prospect and Negotiation are the whole of what a
 * salesman is deciding between when he looks at this list, and they live in
 * `leads`, one table over.
 *
 * `isLead` is the same EXISTS the view chips use, SELECTED rather than only
 * filtered on. That is the rule this file's own header states — on the handset
 * "is this a lead" is a correlated subquery and never a column read, because
 * the office collapsed leads and customers into one `customers` row and
 * `kind` on that row is not the answer.
 *
 * Correlated subqueries rather than a `LEFT JOIN leads`: both tables carry
 * `id`, `name` and `city`, so a join turns every bare column in the WHERE and
 * the ORDER BY ambiguous and the whole builder would have to be requalified to
 * add one word to a card. `leads.id` is the PRIMARY KEY, so each of these is a
 * point lookup.
 *
 * NONE OF THEM BINDS A PARAMETER, which is what keeps the note below about
 * placeholder order true: the six in the projection are still the CASE's own,
 * and they still come before the WHERE's.
 */
const LEAD_FACTS = `${IS_LEAD} AS isLead,
    (SELECT l.funnelStage FROM leads l WHERE l.id = customers.id AND l.archived = 0) AS leadFunnelStage,
    (SELECT l.stage FROM leads l WHERE l.id = customers.id AND l.archived = 0) AS leadStage`;

/**
 * THE SAME THREE COLUMNS, ANSWERED WITHOUT ASKING, on the customer half.
 *
 * That half is `NOT IS_LEAD` by construction, so every row's answer to all
 * three is already known — and asked anyway they are three correlated lookups
 * per row computed BEFORE the sort, because SQLite fills the sorter with the
 * whole projection. On a book of ten thousand that is thirty thousand point
 * lookups to print three constants. The names stay, because the card reads
 * them and `account-label.test.ts` pins that they are there.
 */
const NOT_A_LEAD = `0 AS isLead, NULL AS leadFunnelStage, NULL AS leadStage`;

function leadFacts(view: BookView | undefined): string {
  return view === 'customers' ? NOT_A_LEAD : LEAD_FACTS;
}

/** The clause for a view, or null where everything is wanted. */
function viewClause(view: BookView | undefined): string | null {
  if (view === 'leads') return IS_LEAD;
  if (view === 'customers') return `NOT ${IS_LEAD}`;
  return null;
}

/** Join whatever clauses there are into a WHERE, or an empty string. */
function whereOf(parts: (string | null)[]): string {
  const live = parts.filter(Boolean);
  return live.length ? `WHERE ${live.join(' AND ')}` : '';
}

export type Query = { sql: string; params: (string | number)[] };

/* Name, contact, city, phone, GST and dealer code — because a salesman looking
   somebody up mid-conversation has whichever of those the customer just said. */
/*
 * `%` and `_` typed into the box are LITERALS, escaped, so "50%" does not
 * match every row. The phone is compared on its DIGITS: the book holds
 * `+91 98220 11002` and `09822011002` side by side, and a number typed with
 * spaces or a +91 found neither.
 */
const SEARCH = `lower(name) LIKE ? ESCAPE '\\' OR lower(COALESCE(contactPerson,'')) LIKE ? ESCAPE '\\'
     OR lower(COALESCE(city,'')) LIKE ? ESCAPE '\\'
     OR replace(replace(replace(replace(COALESCE(phone,''),' ',''),'-',''),'+',''),'(','') LIKE ?
     OR lower(COALESCE(gstin,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(dealerCode,'')) LIKE ? ESCAPE '\\'`;

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/** The last ten digits of a typed number, or the text itself if it is not one. */
export function phoneNeedle(q: string): string {
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 5 && digits.length >= q.replace(/\s/g, '').length - 1) {
    return digits.length > 10 ? digits.slice(-10) : digits.replace(/^0+/, '');
  }
  return escapeLike(q);
}

function searchParams(q: string): string[] {
  const like = `%${escapeLike(q)}%`;
  return [like, like, like, `%${phoneNeedle(q)}%`, like, like];
}

function normalise(query: string | undefined): string {
  return (query ?? '').trim().toLowerCase();
}

/* ------------------------------------------------ what the book is cut by */

/**
 * THE QUESTIONS A SALESMAN ASKS OF TEN THOUSAND SHOPS.
 *
 * A search finds a shop he can name. These find the ones he cannot: who owes,
 * who is due to order, who he has not been to. On a book this size the list
 * without them is a phone directory, and nobody plans a morning from a phone
 * directory.
 *
 * EVERY ONE IS READ OFF A COLUMN THE OFFICE SENT, and none carries a number
 * typed here. "Reorder due" is the customer's OWN measured cycle — the same
 * test `reorderState` applies to the card, so the chip and the line under the
 * name cannot disagree about one shop. "Visit due" is the visit frequency the
 * office set for that shop, and a shop with no frequency is not due: inventing
 * a default would be a business rule living in a screen. "Never visited" asks
 * no threshold at all.
 *
 * Day arithmetic is `julianday` on two ISO dates, both midnight, so the
 * difference is a whole number of days with no zone in it — `today` is the
 * caller's business date, resolved once on the handset.
 */
export type CustomerFilter = 'all' | 'owing' | 'reorder' | 'visitDue' | 'neverVisited' | 'unpinned';

export const CUSTOMER_FILTERS: { value: CustomerFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'owing', label: 'Owes money' },
  { value: 'reorder', label: 'Reorder due' },
  { value: 'visitDue', label: 'Visit due' },
  { value: 'neverVisited', label: 'Never visited' },
  { value: 'unpinned', label: 'No map pin' },
];

const FILTER_SQL: Record<Exclude<CustomerFilter, 'all'>, { sql: string; usesToday: boolean }> = {
  owing: { sql: 'COALESCE(outstandingPaise, 0) > 0', usesToday: false },
  reorder: {
    sql: `(lastOrderDate IS NOT NULL AND COALESCE(cycleDays, 0) > 0
           AND julianday(?) - julianday(lastOrderDate) >= cycleDays)`,
    usesToday: true,
  },
  visitDue: {
    sql: `(COALESCE(visitFrequencyDays, 0) > 0
           AND (lastVisitDate IS NULL OR julianday(?) - julianday(lastVisitDate) >= visitFrequencyDays))`,
    usesToday: true,
  },
  neverVisited: { sql: 'lastVisitDate IS NULL', usesToday: false },
  unpinned: { sql: '(gpsLat IS NULL OR gpsLng IS NULL)', usesToday: false },
};

function filterOf(filter: CustomerFilter | undefined, today: string): { sql: string | null; params: string[] } {
  if (!filter || filter === 'all') return { sql: null, params: [] };
  const f = FILTER_SQL[filter];
  return { sql: f.sql, params: f.usesToday ? [today] : [] };
}

/**
 * The order the book comes back in.
 *
 * `near` is distance from whatever origin the screen resolved — and falls back
 * to A–Z where there is none, because a list sorted around an invented origin
 * looks right and is wrong. `owed` is the collections morning. `unseen` puts
 * the shop nobody has ever been to first and then the longest since a visit,
 * which is the question "who have I been neglecting" asked as a sort.
 */
export type CustomerSort = 'near' | 'name' | 'owed' | 'unseen';

/** The caller's business date where it gave one; otherwise the handset's own. */
function todayOr(today: string | undefined): string {
  return today ?? isoDate(new Date());
}

/** How many shops MATCH — the number the screen prints, never a loaded length. */
export function customerCountQuery(
  query?: string,
  view?: BookView,
  filter?: CustomerFilter,
  today?: string,
): Query {
  const q = normalise(query);
  const f = filterOf(filter, todayOr(today));
  const where = whereOf([q ? `(${SEARCH})` : null, viewClause(view), f.sql]);
  return {
    sql: `SELECT COUNT(*) AS n FROM customers ${where}`,
    params: [...(q ? searchParams(q) : []), ...f.params],
  };
}

/**
 * EVERY CHIP'S COUNT IN ONE PASS, over the same search and the same half.
 *
 * Six counts asked as six statements is six scans of the book per keystroke;
 * as one row of `SUM(CASE …)` it is one. The numbers describe the SEARCH, not
 * the picked chip — picking "Owes money" must not turn every other chip to
 * zero, or the row stops being a map of where the work is.
 *
 * The CASE arms bind `today` in the projection, which comes BEFORE the WHERE in
 * the statement, so their parameters are listed first.
 */
export function customerFilterCountsQuery(query?: string, view?: BookView, today?: string): Query {
  const q = normalise(query);
  const day = todayOr(today);
  const where = whereOf([q ? `(${SEARCH})` : null, viewClause(view)]);
  const arms: string[] = [];
  const params: (string | number)[] = [];
  for (const [key, f] of Object.entries(FILTER_SQL)) {
    arms.push(`COALESCE(SUM(CASE WHEN ${f.sql} THEN 1 ELSE 0 END), 0) AS ${key}`);
    if (f.usesToday) params.push(day);
  }
  return {
    sql: `SELECT COUNT(*) AS "all", ${arms.join(', ')} FROM customers ${where}`,
    params: [...params, ...(q ? searchParams(q) : [])],
  };
}

/**
 * One page of the book, nearest first.
 *
 * NO TRIGONOMETRY IN SQL. SQLite has `cos` only where it was compiled with the
 * math extension, and whether Expo's build carries it is not a thing to bet a
 * screen on. So the one cosine is taken in JavaScript — the latitude scaling
 * for the ORIGIN, which is identical for every row being compared — and SQL is
 * left with multiplication. Over a beat, that equirectangular approximation and
 * a great-circle distance agree to far less than the width of a street, and
 * this is a SORT: it has to get the order right, not the metres.
 *
 * The squared distance is never rooted. Ordering by d² is ordering by d, and
 * the root is arithmetic nobody reads.
 *
 * A shop with no coordinates sorts LAST and is still there. Half this book has
 * never been pinned, and dropping those rows would empty the only screen that
 * lists them — a worse answer than putting them under the ones we can place.
 *
 * `id` ends every ordering. A great many shops share a name and, near an
 * origin, a distance; a page boundary falling inside a tie shows one row twice
 * and another not at all. The web app has a test that pages 55 bills for
 * exactly this reason.
 */
export function customerPageQuery(args: {
  query?: string;
  origin?: Origin;
  view?: BookView;
  filter?: CustomerFilter;
  /** Omitted is the old behaviour: nearest where there is an origin, else A–Z. */
  sort?: CustomerSort;
  today?: string;
  limit?: number;
  offset?: number;
} = {}): Query {
  const q = normalise(args.query);
  const limit = args.limit ?? CUSTOMER_PAGE;
  const offset = args.offset ?? 0;
  const sort = args.sort ?? 'near';
  /* Distance is measured only where it is the order asked for. Computed under
     another sort it is arithmetic over every row that nobody reads. */
  const origin = sort === 'near' ? (args.origin ?? null) : null;
  const facts = leadFacts(args.view);

  /* The view clause carries no parameters of its own; the filter's follow the
     search's, in the order the two appear in the WHERE. The binding order
     below — projection, then where, then the page — is unchanged by either. */
  const f = filterOf(args.filter, todayOr(args.today));
  const where = whereOf([q ? `(${SEARCH})` : null, viewClause(args.view), f.sql]);
  const whereParams = [...(q ? searchParams(q) : []), ...f.params];

  if (!origin) {
    const order =
      sort === 'owed'
        ? 'COALESCE(outstandingPaise, 0) DESC, name COLLATE NOCASE, id'
        : sort === 'unseen'
          ? '(lastVisitDate IS NOT NULL), lastVisitDate, name COLLATE NOCASE, id'
          : 'name COLLATE NOCASE, id';
    return {
      sql: `SELECT *, ${facts} FROM customers ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      params: [...whereParams, limit, offset],
    };
  }

  const kx = Math.cos((origin.lat * Math.PI) / 180);
  /* The SELECT list is bound BEFORE the WHERE, because that is the order the
     placeholders appear in the statement. Six of them, all in the projection. */
  return {
    sql: `SELECT *, ${facts},
            CASE WHEN gpsLat IS NULL OR gpsLng IS NULL THEN NULL
                 ELSE ((gpsLat - ?) * (gpsLat - ?))
                    + (((gpsLng - ?) * ?) * ((gpsLng - ?) * ?))
            END AS dist2
          FROM customers ${where}
          ORDER BY (dist2 IS NULL), dist2, name COLLATE NOCASE, id
          LIMIT ? OFFSET ?`,
    params: [
      origin.lat, origin.lat,
      origin.lng, kx, origin.lng, kx,
      ...whereParams,
      limit, offset,
    ],
  };
}

/* ------------------------------------------------- one customer's timeline */

/**
 * HOW MANY ENTRIES A TIMELINE READ IS CAPPED AT.
 *
 * One constant, so the read, the screen's slice line and anything that counts
 * them cannot disagree — the same rule `CUSTOMER_PAGE` above is written under.
 */
export const TIMELINE_PAGE = 100;

/**
 * Which stored event types each filter chip asks for.
 *
 * `payment_bounced` sits under Payments because that is what the timeline's own
 * badge already calls it. A filter that hides a row the All tab has just
 * labelled "Payment" is the same falsehood one step along.
 */
export const TIMELINE_KINDS: Record<string, string[]> = {
  Visits: ['visit'],
  Orders: ['order'],
  Payments: ['payment', 'payment_bounced'],
  Calls: ['call', 'telecaller_call'],
  Complaints: ['complaint'],
};

/**
 * ONE KIND'S NEWEST PAGE, ASKED OF SQL — never a window filtered afterwards.
 *
 * This read was `ORDER BY occurredAt DESC LIMIT 100` and the kind was then
 * applied to those hundred rows in JavaScript, on the screen. So on a shop with
 * a hundred recent visits — which is an ordinary shop — picking Payments
 * matched nothing in the window and returned nothing at all, and the screen
 * stated it as a fact: "this shop has history, but none of it is payments".
 * A salesman standing at the counter told a customer we had no record of their
 * payment, on the strength of a cap nothing on the screen mentioned.
 *
 * With the kind in the WHERE, the cap is a hundred OF THAT KIND and the page is
 * that kind's newest. A chip naming no kinds falls through to the whole stream,
 * which is what All is.
 *
 * `id` ends the ordering for the reason it ends every other ordering in this
 * file: a stream carries ties, and a tie broken by the planner is a row that
 * moves between reads.
 */
export function customerTimelineQuery(customerId: string, filter = 'All'): Query {
  const kinds = TIMELINE_KINDS[filter] ?? [];
  const where = kinds.length
    ? `customerId = ? AND eventType IN (${kinds.map(() => '?').join(',')})`
    : 'customerId = ?';
  return {
    sql: `SELECT * FROM timeline_events
           WHERE ${where}
           ORDER BY occurredAt DESC, id DESC
           LIMIT ${TIMELINE_PAGE}`,
    params: [customerId, ...kinds],
  };
}

/** Degrees of latitude to metres. Good to a few parts in ten thousand. */
const METRES_PER_DEGREE = 111_320;

/**
 * The `dist2` a page carries, as metres.
 *
 * Deliberately here, beside the SQL that produced it, because the two share a
 * definition: `dist2` is squared degrees with longitude already scaled by
 * cos(latitude), so the conversion is one square root and one constant. Put
 * this anywhere else and the day the ordering changes shape, the number on the
 * card goes on being computed the old way and quietly disagrees with the order
 * the rows are in.
 *
 * That shared origin is the point. A card cannot show a smaller distance than
 * the card above it, because the figure it prints and the figure it was sorted
 * by are the same number.
 */
export function metresFromDist2(dist2: number | null | undefined): number | null {
  if (dist2 == null || !Number.isFinite(dist2) || dist2 < 0) return null;
  return Math.sqrt(dist2) * METRES_PER_DEGREE;
}

/**
 *
 * Built from the book rather than from a list of town names typed into a
 * screen — the same rule the web app states about product lists, for the same
 * reason: the day somebody sells into a new town, a hardcoded list is wrong and
 * nothing says so. A city with no pinned shop cannot be an origin, so it is not
 * offered as one.
 */
export function cityOriginsQuery(limit = 300): Query {
  return {
    sql: `SELECT city AS city, COUNT(*) AS n,
                 AVG(gpsLat) AS lat, AVG(gpsLng) AS lng
            FROM customers
           WHERE city IS NOT NULL AND trim(city) <> ''
             AND gpsLat IS NOT NULL AND gpsLng IS NOT NULL
           GROUP BY lower(trim(city))
           ORDER BY n DESC, city COLLATE NOCASE
           LIMIT ?`,
    params: [limit],
  };
}

/* ------------------------------------------------------- customer accounts */

/**
 * Which accounts the Customer accounts screen lists.
 *
 * It is the CUSTOMERS view of the book — the same `NOT IS_LEAD` the chips on
 * the Customers tab use — because a lead has never been billed and an account
 * screen full of empty statements is a screen that hides the ones that matter.
 * The chips narrow by MONEY rather than by place: who owes, who is past the
 * limit the office set, who the office has stopped supplying, and the shops
 * somebody else invoices.
 */
export type AccountFilter = 'all' | 'owing' | 'over' | 'blocked' | 'third';
export type AccountSort = 'owed' | 'name';

function accountClause(filter: AccountFilter): string | null {
  switch (filter) {
    case 'owing':
      return 'COALESCE(outstandingPaise, 0) > 0';
    case 'over':
      return 'COALESCE(creditLimitPaise, 0) > 0 AND COALESCE(outstandingPaise, 0) > creditLimitPaise';
    case 'blocked':
      return 'COALESCE(creditBlocked, 0) = 1';
    case 'third':
      return 'COALESCE(thirdParty, 0) = 1';
    case 'all':
    default:
      return null;
  }
}

/** How many accounts match — the number the screen prints. */
export function accountCountQuery(query: string | undefined, filter: AccountFilter): Query {
  const q = normalise(query);
  const where = whereOf([`NOT ${IS_LEAD}`, q ? `(${SEARCH})` : null, accountClause(filter)]);
  return { sql: `SELECT COUNT(*) AS n FROM customers ${where}`, params: q ? searchParams(q) : [] };
}

/**
 * One page of accounts. `name, id` breaks every tie, so a page boundary never
 * shows one shop twice or skips another — the paging rule MahekOne's own lists
 * learned the hard way.
 */
export function accountPageQuery(args: {
  query?: string;
  filter: AccountFilter;
  sort: AccountSort;
  offset: number;
  limit: number;
}): Query {
  const q = normalise(args.query);
  const where = whereOf([`NOT ${IS_LEAD}`, q ? `(${SEARCH})` : null, accountClause(args.filter)]);
  const order =
    args.sort === 'name'
      ? 'lower(name) ASC, id ASC'
      : 'COALESCE(outstandingPaise, 0) DESC, lower(name) ASC, id ASC';
  return {
    sql: `SELECT * FROM customers ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    params: [...(q ? searchParams(q) : []), args.limit, args.offset],
  };
}

/**
 * The whole book's money in one row, for the strip above the list. It is the
 * office's own `outstandingPaise` added up — never a debt worked out on the
 * phone — and it describes the BOOK, not the filter, so it does not move as
 * chips are tapped.
 */
export const ACCOUNT_SUMMARY_SQL = `SELECT
    COUNT(*) AS accounts,
    COALESCE(SUM(CASE WHEN COALESCE(outstandingPaise, 0) > 0 THEN outstandingPaise ELSE 0 END), 0) AS owedPaise,
    COALESCE(SUM(CASE WHEN COALESCE(outstandingPaise, 0) > 0 THEN 1 ELSE 0 END), 0) AS owing,
    COALESCE(SUM(CASE WHEN COALESCE(creditLimitPaise, 0) > 0 AND COALESCE(outstandingPaise, 0) > creditLimitPaise THEN 1 ELSE 0 END), 0) AS over,
    COALESCE(SUM(CASE WHEN COALESCE(creditBlocked, 0) = 1 THEN 1 ELSE 0 END), 0) AS blocked,
    MAX(lastSyncedAt) AS syncedAt
  FROM customers WHERE NOT ${IS_LEAD}`;
