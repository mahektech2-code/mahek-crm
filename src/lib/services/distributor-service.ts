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
 */
export async function distributorCandidates(
  query: string,
  opts: { excludeCustomerId?: string; limit?: number } = {},
): Promise<DistributorCandidate[]> {
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
    where.push(
      or(
        sql`${customers.name} ilike ${like}`,
        sql`${customers.city} ilike ${like}`,
        sql`${customers.externalCode} ilike ${like}`,
      )!,
    );
  }

  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      city: customers.city,
      shops: sql<number>`(
        select count(*)::int from customer_distributors d
         where d.distributor_customer_id = customers.id
      )`,
      deliveries: sql<number>`(
        select count(*)::int from orders o
         where o.customer_id = customers.id and o.delivery_customer_id is not null
      )`,
    })
    .from(customers)
    .where(and(...where))
    /*
     * The ones that already serve somebody first, then by name. Whoever is
     * marking a batch of shops is usually naming the same two or three
     * distributors over and over, and an alphabetical list buries them.
     */
    .orderBy(sql`(
      select count(*) from customer_distributors d
       where d.distributor_customer_id = customers.id
    ) desc`, asc(customers.name))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    city: r.city,
    shops: Number(r.shops),
    deliveries: Number(r.deliveries),
  }));
}

/**
 * How many shops each of these accounts serves, in one query.
 *
 * For the customers list, which draws the count on a direct customer's row.
 * Asked per row it would be one query per row.
 */
export async function servedShopCounts(
  distributorIds: string[],
): Promise<Map<string, number>> {
  if (!distributorIds.length) return new Map();
  const rows = await db
    .select({
      id: customerDistributors.distributorCustomerId,
      n: sql<number>`count(*)::int`,
    })
    .from(customerDistributors)
    .where(
      sql`${customerDistributors.distributorCustomerId} = any(${sql.param(distributorIds)})`,
    )
    .groupBy(customerDistributors.distributorCustomerId);
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
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
