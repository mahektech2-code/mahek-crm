import "server-only";
import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { customerDistributors, customers, orders } from "@/db/schema";

/* ---------------------------------------------------------------------------
 * The arrangement behind the mark.
 *
 * `customers.thirdParty` says a shop is served through a distributor;
 * `customer_distributors` says which. Everything here READS that — the writes
 * are in `lib/actions/third-party.ts`, like every other write in this codebase.
 *
 * Two directions, because two screens ask opposite questions of one table. On
 * a third-party customer: who bills this shop. On a direct customer: which
 * shops do we deliver to on their bill. They are the same rows read from
 * either end, so the two can never disagree about a pair.
 * ------------------------------------------------------------------------- */

export type DistributorLink = {
  id: string;
  distributorId: string;
  distributorName: string;
  distributorCity: string | null;
  /** Whether that account is still one we bill. See `stillDirect`. */
  stillDirect: boolean;
  isPrimary: boolean;
  note: string | null;
  /**
   * Orders billed to this distributor whose goods came to the shop. The
   * EVIDENCE beside the arrangement — a stated distributor with no deliveries
   * behind it is worth seeing as exactly that, and so is a distributor with
   * two hundred.
   */
  deliveredOrders: number;
  lastDeliveredAt: string | null;
};

/** A shop served through a distributor, read from the distributor's end. */
export type ServedShop = {
  id: string;
  customerId: string;
  customerName: string;
  customerCity: string | null;
  isPrimary: boolean;
  note: string | null;
  deliveredOrders: number;
  lastDeliveredAt: string | null;
};

/**
 * How many orders billed to `distributorId` were delivered to `customerId`.
 *
 * Correlated on both sides and spelled out rather than referenced through
 * Drizzle: `${orders.customerId}` renders bare, and a bare column inside a
 * correlated subquery binds to the inner table — the rule this codebase
 * already documents, and the one that shipped a silent `true` once.
 */
const DELIVERED_COUNT_SQL = sql<number>`(
  select count(*)::int from orders o
   where o.customer_id = customer_distributors.distributor_customer_id
     and o.delivery_customer_id = customer_distributors.customer_id
)`;

const DELIVERED_LAST_SQL = sql<string | null>`(
  select to_char(max(o.ordered_at) at time zone 'Asia/Kolkata', 'YYYY-MM-DD')
    from orders o
   where o.customer_id = customer_distributors.distributor_customer_id
     and o.delivery_customer_id = customer_distributors.customer_id
)`;

/** Who bills this shop. Ordered with the usual one first. */
export async function distributorsFor(customerId: string): Promise<DistributorLink[]> {
  const rows = await db
    .select({
      id: customerDistributors.id,
      distributorId: customers.id,
      distributorName: customers.name,
      distributorCity: customers.city,
      kind: customers.kind,
      thirdParty: customers.thirdParty,
      isPrimary: customerDistributors.isPrimary,
      note: customerDistributors.note,
      deliveredOrders: DELIVERED_COUNT_SQL,
      lastDeliveredAt: DELIVERED_LAST_SQL,
    })
    .from(customerDistributors)
    .innerJoin(customers, eq(customers.id, customerDistributors.distributorCustomerId))
    .where(eq(customerDistributors.customerId, customerId))
    .orderBy(desc(customerDistributors.isPrimary), asc(customers.name));

  return rows.map((r) => ({
    id: r.id,
    distributorId: r.distributorId,
    distributorName: r.distributorName,
    distributorCity: r.distributorCity,
    /*
     * A link is not rewritten when the account at the other end of it changes.
     * A distributor that has since been marked as a third party itself, or that
     * is somehow back to being a lead, is still who billed this shop — the row
     * stands and the screen says the arrangement needs looking at. Deleting it
     * on read would destroy the only record of it.
     */
    stillDirect: r.kind === "customer" && !r.thirdParty,
    isPrimary: r.isPrimary,
    note: r.note,
    deliveredOrders: Number(r.deliveredOrders),
    lastDeliveredAt: r.lastDeliveredAt,
  }));
}

/** Which shops we deliver to on this account's bill. */
export async function shopsServedBy(distributorId: string): Promise<ServedShop[]> {
  const rows = await db
    .select({
      id: customerDistributors.id,
      customerId: customers.id,
      customerName: customers.name,
      customerCity: customers.city,
      isPrimary: customerDistributors.isPrimary,
      note: customerDistributors.note,
      deliveredOrders: DELIVERED_COUNT_SQL,
      lastDeliveredAt: DELIVERED_LAST_SQL,
    })
    .from(customerDistributors)
    .innerJoin(customers, eq(customers.id, customerDistributors.customerId))
    .where(eq(customerDistributors.distributorCustomerId, distributorId))
    .orderBy(desc(customerDistributors.isPrimary), asc(customers.name));

  return rows.map((r) => ({
    id: r.id,
    customerId: r.customerId,
    customerName: r.customerName,
    customerCity: r.customerCity,
    isPrimary: r.isPrimary,
    note: r.note,
    deliveredOrders: Number(r.deliveredOrders),
    lastDeliveredAt: r.lastDeliveredAt,
  }));
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
  if (q) {
    const like = `%${q}%`;
    const clauses = [
      sql`${customers.name} ilike ${like}`,
      sql`${customers.city} ilike ${like}`,
      sql`${customers.externalCode} ilike ${like}`,
    ];
    // Below three characters similarity is noise — every short string is a
    // little bit like every name — so a typo is only forgiven once there is
    // enough typed to tell what was meant.
    if (q.length >= 3) {
      clauses.push(sql`similarity(${customers.name}, ${q}) > 0.3`);
    }
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
