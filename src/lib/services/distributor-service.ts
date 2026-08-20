import "server-only";
import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { customerDistributors, customers, orders } from "@/db/schema";
import { APP_TIMEZONE } from "@/lib/business-date";

/* ---------------------------------------------------------------------------
 * The arrangement behind the mark.
 *
 * `customers.thirdParty` says a shop is served through a distributor;
 * `customer_distributors` says which. Everything here READS that — the writes
 * are in `lib/actions/third-party.ts`, like every other write in this codebase.
 *
 * Two directions, because two screens ask opposite questions of one table. On
 * a third-party customer: who bills this shop. On a direct customer: which
 * shops do we deliver to on their bill — its delivery addresses. They are the
 * same rows read from either end, so the two records can never disagree about
 * a pair.
 *
 * Each direction answers with the ARRANGEMENT AND THE SHEET IN ONE LIST. See
 * `DeliveryRelation`: two lists side by side was the shape that put four rows
 * beside eighty-six under two titles and left nobody able to say what the
 * difference was.
 * ------------------------------------------------------------------------- */

/**
 * ONE ANSWER PER SHOP, whether a person recorded it or the sheet saw it.
 *
 * There were two panels on the customer record answering one question between
 * them: the arrangement somebody recorded, and — under a title of its own —
 * every shop the Taken Order tab shows goods going to. Four rows beside
 * eighty-six, two counts, one question. Nobody reading that page could say
 * what the difference was, which is the definition of a screen that has stopped
 * answering.
 *
 * They are one list now, and the second source becomes the WORKLIST: a shop
 * the sheet has seen and nobody has recorded is exactly the row somebody
 * should act on, so it sits in the same list as the recorded ones saying so,
 * with the button that records it. The list shrinks into the recorded half as
 * the work is done, which is what makes it a queue rather than a report.
 *
 * `recorded` is the difference and it is drawn on every row. It is never
 * inferred from the order count: a shop can be recorded with no deliveries
 * behind it yet, and a shop with two hundred deliveries can be unrecorded.
 * Those are both real, and both worth seeing.
 */
export type DeliveryRelation = {
  /** The account at the other end — the shop, or the distributor. */
  customerId: string;
  name: string;
  city: string | null;
  /** Somebody recorded this arrangement. False means only the sheet knows. */
  recorded: boolean;
  /** The link row, where there is one — what Edit and Remove act on. */
  linkId: string | null;
  isPrimary: boolean;
  note: string | null;
  /** Still an account we bill. Only meaningful on a distributor. */
  stillDirect: boolean;
  /** What kind of record the OTHER account is, which decides how to record it. */
  kind: "lead" | "customer";
  thirdParty: boolean;
  /** Orders the sheet shows going between the two. */
  orders: number;
  lastAt: string | null;
};

type RelationRow = {
  customerId: string;
  name: string;
  city: string | null;
  kind: "lead" | "customer";
  thirdParty: boolean;
  linkId: string | null;
  isPrimary: boolean | null;
  note: string | null;
  orders: number;
  lastAt: string | null;
};

const toRelation = (r: RelationRow): DeliveryRelation => ({
  customerId: r.customerId,
  name: r.name,
  city: r.city,
  recorded: r.linkId !== null,
  linkId: r.linkId,
  isPrimary: r.isPrimary ?? false,
  note: r.note,
  stillDirect: r.kind === "customer" && !r.thirdParty,
  kind: r.kind,
  thirdParty: r.thirdParty,
  orders: Number(r.orders),
  lastAt: r.lastAt,
});

/**
 * A FULL JOIN of the two sources, in SQL rather than in two queries stitched
 * together in JavaScript. Stitching is where "the same shop twice" comes from:
 * one row from the link, one from the orders, and nothing to say they are one
 * account.
 */
function relationSql(anchorId: string, direction: "shops" | "distributors") {
  // Which end of the pair is the OTHER account, on each side of the join.
  const linkOther =
    direction === "shops" ? sql`d.customer_id` : sql`d.distributor_customer_id`;
  const linkAnchor =
    direction === "shops" ? sql`d.distributor_customer_id` : sql`d.customer_id`;
  const orderOther =
    direction === "shops" ? sql`o.delivery_customer_id` : sql`o.customer_id`;
  const orderAnchor =
    direction === "shops" ? sql`o.customer_id` : sql`o.delivery_customer_id`;

  return sql`
    with recorded as (
      select ${linkOther} as customer_id, d.id as link_id,
             d.is_primary, d.note
        from customer_distributors d
       where ${linkAnchor} = ${anchorId}
    ),
    seen as (
      select ${orderOther} as customer_id,
             count(*)::int as orders,
             to_char(max(o.ordered_at) at time zone ${APP_TIMEZONE}, 'YYYY-MM-DD') as last_at
        from orders o
       where ${orderAnchor} = ${anchorId}
         and ${orderOther} is not null
         and o.delivery_customer_id is not null
       group by ${orderOther}
    )
    select c.id as "customerId", c.name, c.city,
           c.kind::text as kind, c.third_party as "thirdParty",
           r.link_id as "linkId", r.is_primary as "isPrimary", r.note,
           coalesce(s.orders, 0) as orders, s.last_at as "lastAt"
      from recorded r
      full join seen s on s.customer_id = r.customer_id
      join customers c on c.id = coalesce(r.customer_id, s.customer_id)
     order by (r.link_id is not null) desc, r.is_primary desc nulls last,
              coalesce(s.orders, 0) desc, c.name asc
  `;
}

/** Who bills this shop — recorded first, then whoever the sheet has seen. */
export async function distributorsFor(
  customerId: string,
): Promise<DeliveryRelation[]> {
  const rows = await db.execute<RelationRow>(
    relationSql(customerId, "distributors"),
  );
  return [...rows].map(toRelation);
}

/**
 * The shops this account's goods go to — its delivery addresses.
 *
 * The same rows read from the other end, so the two records can never disagree
 * about a pair: what the shop's page calls its distributor is what the
 * distributor's page calls its delivery address.
 */
export async function deliveryAddressesFor(
  distributorId: string,
): Promise<DeliveryRelation[]> {
  const rows = await db.execute<RelationRow>(relationSql(distributorId, "shops"));
  return [...rows].map(toRelation);
}

export type DistributorCandidate = {
  id: string;
  name: string;
  city: string;
  /** Shops already served through them — context for picking one. */
  shops: number;
  /** Deliveries this account has already billed for, from the order history. */
  deliveries: number;
};

export type DistributorCandidates = {
  hits: DistributorCandidate[];
  /**
   * WHICH RULE ANSWERED — sent to the screen so the empty state can say what
   * was actually searched. "No direct customer matches that" is wrong and
   * unhelpful when what happened is that nothing STARTS with the letter typed,
   * and the way forward is to keep typing. The rule lives here, so the sentence
   * on the screen cannot describe a different one.
   */
  mode: "prefix" | "wide";
  /**
   * Matches the cap left out. A list that simply stops looks like the whole
   * answer, and somebody who cannot see their distributor concludes we do not
   * hold it — so the screen says there are more and to keep typing.
   */
  more: number;
};

/**
 * WHAT WAS TYPED DECIDES THE ORDER. It did not, and that was the bug.
 *
 * The first version ranked by how many shops an account already serves and
 * then alphabetically, ignoring the query completely — so typing "c" put "A
 * MUNSI PAINT and chemicals" above every account whose name begins with one,
 * matched on the c in its ninth word. On a book of 561 direct customers that
 * makes the box unusable for its actual job: you type the first letters of a
 * name you know, and the thing you are looking for is not on screen.
 *
 * The buckets below are the ranking, most specific first, and every one of
 * them is a real distinction somebody makes while typing: the exact name, then
 * a name that starts the way they typed, then a WORD inside it that does —
 * "paints" should find "Shree Paints" — then anything containing it, then the
 * code, then the town. Shops-served is still in there, and still means what it
 * meant: among matches equally good, the account already distributing for us
 * is the likely answer. It just no longer outranks the query.
 */
const CANDIDATE_RANK_SQL = (q: string) => {
  // The word-boundary test is a regular expression, so anything the person
  // typed that means something to a regex has to stop meaning it. A shop
  // called "R.K. Paints (Nashik)" is an ordinary name and a broken pattern.
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return sql<number>`case
    when lower(${customers.name}) = lower(${q}) then 1
    when ${customers.name} ilike ${q + "%"} then 2
    when ${customers.name} ~* ${"\\m" + escaped} then 3
    when ${customers.name} ilike ${"%" + q + "%"} then 4
    when ${customers.externalCode} ilike ${"%" + q + "%"} then 5
    when ${customers.city} ilike ${q + "%"} then 6
    when ${customers.city} ilike ${"%" + q + "%"} then 7
    else 8
  end`;
};

/**
 * The accounts that may be named as a distributor.
 *
 * Direct customers only: `kind = 'customer'` and NOT itself marked. A
 * distributor is somebody we bill, so a shop we deliver to cannot be one —
 * that would be a chain with nobody at the end of it holding an invoice. The
 * action checks the same thing, because a picker is not a permission.
 *
 * Deactivated accounts are left out: naming one as who bills a shop from
 * today is an arrangement that cannot happen. Links already pointing at one
 * are kept and flagged on the record instead of being quietly dropped.
 *
 * A NAME TYPED MID-CALL IS A NAME TYPED BADLY, which the product search
 * already knows — so three characters or more also match on trigram
 * similarity, and "shre paints" finds Shree Paints rather than nothing. There
 * is no trigram index on `customers.name` and none is needed: the filter runs
 * over the few hundred rows this predicate already narrows to.
 */
const SHORT_QUERY = 3;

export async function distributorCandidates(
  query: string,
  opts: { excludeCustomerId?: string; limit?: number } = {},
): Promise<DistributorCandidates> {
  const q = query.trim();
  const limit = opts.limit ?? 20;

  const where = [
    eq(customers.kind, "customer"),
    eq(customers.thirdParty, false),
    ne(customers.status, "deactivated"),
  ];
  if (opts.excludeCustomerId) where.push(ne(customers.id, opts.excludeCustomerId));
  /*
   * A SHORT QUERY IS A FIRST LETTER, NOT A SUBSTRING.
   *
   * Somebody typing one or two characters is spelling the START of a name they
   * already know — nobody types "c" meaning "any account with a c in it
   * somewhere". Matching inside words at that length answers a question nobody
   * asked and fills the twenty rows with it: on this book, "c" returned "A
   * MUNSI PAINT and chemicals", "A TO Z COLOURS", "AARTI ELECTRIC & HARDWARE"
   * and "ACC HOME DECOR" — four accounts, not one of them beginning with a C,
   * ahead of every account that does.
   *
   * So under three characters the filter is the name's own first letters and
   * nothing else. From three characters on it widens, because by then somebody
   * is typing a word rather than a letter — "paints" should find "Shree
   * Paints", the town and the code become worth searching, and a near miss is
   * worth forgiving.
   */
  if (q) {
    const like = `%${q}%`;
    const prefix = `${q}%`;
    const clauses =
      q.length < SHORT_QUERY
        ? [sql`${customers.name} ilike ${prefix}`]
        : [
            sql`${customers.name} ilike ${like}`,
            sql`${customers.city} ilike ${like}`,
            sql`${customers.externalCode} ilike ${like}`,
            // A name typed mid-call is a name typed badly, which is the rule
            // the product search already follows. Below three characters
            // similarity is noise — every short string is a little bit like
            // every name — which is the other reason for the boundary above.
            sql`similarity(${customers.name}, ${q}) > 0.3`,
          ];
    where.push(or(...clauses)!);
  }

  const shopsSql = sql<number>`(
    select count(*)::int from customer_distributors d
     where d.distributor_customer_id = customers.id
  )`;

  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      city: customers.city,
      shops: shopsSql,
      deliveries: sql<number>`(
        select count(*)::int from orders o
         where o.customer_id = customers.id and o.delivery_customer_id is not null
      )`,
    })
    .from(customers)
    .where(and(...where))
    .orderBy(
      // With nothing typed there is nothing to rank against, and the useful
      // answer is the accounts that already distribute for us.
      ...(q ? [CANDIDATE_RANK_SQL(q), desc(sql`similarity(${customers.name}, ${q})`)] : []),
      desc(shopsSql),
      asc(customers.name),
    )
    // One more than the cap, purely to find out whether there IS one more.
    .limit(limit + 1);

  return {
    mode: q && q.length < SHORT_QUERY ? "prefix" : "wide",
    hits: rows.slice(0, limit).map((r) => ({
      id: r.id,
      name: r.name,
      city: r.city,
      shops: Number(r.shops),
      deliveries: Number(r.deliveries),
    })),
    more: rows.length > limit ? rows.length - limit : 0,
  };
}

/*
 * "Third-party accounts with nobody billing them" was a function here and is
 * now a value of the customers list's own type filter. It is the same
 * question, and answering it on the screen where the work is done beats
 * answering it in a report nobody opens.
 */

/**
 * The distributor the ORDER HISTORY suggests, for a shop nobody has named one
 * for. Offered as a starting point in the convert dialog and never written
 * without somebody choosing it — the whole subsystem exists because a
 * spreadsheet column was once allowed to decide what a record was.
 */
export async function suggestedDistributors(
  customerId: string,
): Promise<Array<{ id: string; name: string; orders: number }>> {
  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      orders: sql<number>`count(*)::int`,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(
      and(
        eq(orders.deliveryCustomerId, customerId),
        eq(customers.kind, "customer"),
        eq(customers.thirdParty, false),
      ),
    )
    .groupBy(customers.id, customers.name)
    .orderBy(desc(sql`count(*)`))
    .limit(5);
  return rows.map((r) => ({ ...r, orders: Number(r.orders) }));
}

export type AccountServing = {
  /** True where this account is a shop somebody else bills. */
  thirdParty: boolean;
  /** Who bills it. Empty on anything that is not a third-party customer. */
  distributors: Array<{ id: string; name: string; isPrimary: boolean }>;
  /** Third-party customers billed through this account. */
  shops: number;
};

/**
 * The one-line answer to "how is this account served", for screens that need
 * the fact and not the arrangement.
 *
 * The accounts statement is the case this exists for: a third-party customer
 * has no bills and never will, and a statement of nothing with nothing saying
 * why reads as data missing rather than as the arrangement working. One query
 * per side, both narrow.
 */
export async function accountServing(customerId: string): Promise<AccountServing> {
  const [[row], links, served] = await Promise.all([
    db
      .select({ thirdParty: customers.thirdParty })
      .from(customers)
      .where(eq(customers.id, customerId)),
    db
      .select({
        id: customers.id,
        name: customers.name,
        isPrimary: customerDistributors.isPrimary,
      })
      .from(customerDistributors)
      .innerJoin(customers, eq(customers.id, customerDistributors.distributorCustomerId))
      .where(eq(customerDistributors.customerId, customerId))
      .orderBy(desc(customerDistributors.isPrimary), asc(customers.name)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(customerDistributors)
      .where(eq(customerDistributors.distributorCustomerId, customerId)),
  ]);

  return {
    thirdParty: row?.thirdParty ?? false,
    distributors: links,
    shops: Number(served[0]?.n ?? 0),
  };
}
