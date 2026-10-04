import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { resolveScope, scopedUserIds, scopedToUsers } from "@/lib/access-control";
import { orderCountsSql, orderValueSql } from "@/lib/order-status";
import { today } from "@/lib/recompute";
import {
  BACK_OFFICE_AM_NAME_SQL,
  PLACE_NAMES_SQL,
  SALES_AM_NAME_SQL,
} from "@/lib/queries";
import type { PlaceNames } from "@/lib/place-filters";

/* ---------------------------------------------------------------------------
 * The company's top customers, and which of them are yours.
 *
 * THE RANKING IS COMPANY-WIDE, AND THE SCOPE ONLY DECIDES WHICH ROWS YOU SEE.
 * That is the whole design and it is easy to get backwards. "Top 60 of my own
 * book" would put a telecaller's sixtieth-best shop on a list called Top
 * customers, and two people's lists would then use the same words about
 * accounts of completely different weight. So the sixty are chosen across
 * every book first, each keeps its company rank, and THEN the viewer's scope
 * is applied — `scopedToUsers`, the same narrowing the Customers list runs, so
 * a back office telecaller sees exactly the top accounts they would also find
 * on their own Customers screen. An admin's scope is the whole company and
 * sees all sixty.
 *
 * "Did we sell anything" is `orderCountsSql` and "what was it worth" is
 * `orderValueSql` — the two every money figure in the product reads, so a
 * pending or declined order never ranks anybody. Both the length of the list
 * and the window are configuration.
 * ------------------------------------------------------------------------- */

export type TopCustomerMetric = "value" | "orders";

export const TOP_CUSTOMER_METRICS: readonly TopCustomerMetric[] = ["value", "orders"];

export type TopCustomerRow = {
  /** Where this account stands across the WHOLE company, not within the list shown. */
  rank: number;
  id: string;
  name: string;
  phone: string;
  thirdParty: boolean;
  place: PlaceNames;
  city: string;
  salesAmName: string | null;
  backOfficeAmName: string | null;
  orders: number;
  valuePaise: number;
  lastOrderedOn: string;
  outstandingPaise: number;
};

export type TopCustomers = {
  metric: TopCustomerMetric;
  /** The configured length of the company list. */
  limit: number;
  months: number;
  /** First and last business dates of the window, inclusive. */
  from: string;
  to: string;
  /** The rows this viewer may see, in company rank order. */
  rows: TopCustomerRow[];
  /** How many accounts actually made the company list — fewer than `limit` on a quiet book. */
  companyCount: number;
  /** What the whole company list is worth, and what everybody sold in the window. */
  companyTopValuePaise: number;
  companyValuePaise: number;
  /** True where the viewer's scope is the whole company, so every row is shown. */
  wholeCompany: boolean;
};

export async function topCustomers(metric: TopCustomerMetric): Promise<TopCustomers> {
  const [ctx, config, to] = await Promise.all([resolveScope(), getConfig(), today()]);
  const ids = scopedUserIds(ctx.scope);
  const limit = config["topCustomers.count"];
  const months = config["topCustomers.months"];

  /*
   * A tiebreaker in every ordering: two shops with the same order count are
   * ordinary, and leaving their order to the planner would let a rank change
   * between two loads of the same page.
   */
  const order =
    metric === "orders"
      ? sql`agg.orders desc, agg.value desc, agg.customer_id`
      : sql`agg.value desc, agg.orders desc, agg.customer_id`;

  /*
   * The window is whole business days, and each end names the zone — a bare
   * cast would read the midnight in the session's zone, which is not a
   * property of the row. `months` is cast to int because an untyped parameter
   * beside a date lets Postgres pick the wrong operator. Both reads below use
   * this one statement of it, so the list and the totals above it cannot
   * describe two different windows.
   */
  const windowed = sql`
    bounds as (
      select (${to}::date - make_interval(months => ${months}::int) + interval '1 day')::date as from_day,
             ${to}::date as to_day
    ),
    agg as (
      select o.customer_id,
             sum(${orderValueSql("o")})::bigint as value,
             count(*)::int as orders,
             max(o.ordered_at) as last_ordered_at
        from orders o
        join customers c on c.id = o.customer_id
       cross join bounds b
       where ${orderCountsSql("o")}
         and c.deleted_at is null
         and o.ordered_at >= b.from_day::timestamp at time zone ${APP_TIMEZONE}
         and o.ordered_at < (b.to_day + 1)::timestamp at time zone ${APP_TIMEZONE}
       group by o.customer_id
    )`;

  const result = await db.execute(sql`
    with ${windowed},
    top as (
      select agg.*, row_number() over (order by ${order})::int as rank
        from agg
       order by rank
       limit ${limit}::int
    )
    select top.rank,
           top.orders,
           top.value::text as value,
           to_char(top.last_ordered_at at time zone ${APP_TIMEZONE}, 'YYYY-MM-DD') as last_ordered_on,
           customers.id,
           customers.name,
           customers.phone,
           customers.city,
           customers.third_party,
           customers.outstanding::text as outstanding,
           ${PLACE_NAMES_SQL} as place,
           ${SALES_AM_NAME_SQL} as sales_am_name,
           ${BACK_OFFICE_AM_NAME_SQL} as back_office_am_name
      from top
      join customers on customers.id = top.customer_id
     where ${scopedToUsers(ids)}
     order by top.rank
  `);

  const [totals] = (
    await db.execute(sql`
      with ${windowed},
      top as (
        select agg.value from agg order by ${order} limit ${limit}::int
      )
      select (select from_day::text from bounds) as from_day,
             (select count(*)::int from top) as top_count,
             (select coalesce(sum(value), 0)::text from top) as top_value,
             (select coalesce(sum(value), 0)::text from agg) as all_value
    `)
  ) as unknown as {
    from_day: string;
    top_count: number;
    top_value: string;
    all_value: string;
  }[];

  type Raw = {
    rank: number;
    orders: number;
    value: string;
    last_ordered_on: string;
    id: string;
    name: string;
    phone: string;
    city: string;
    third_party: boolean;
    outstanding: string;
    place: PlaceNames;
    sales_am_name: string | null;
    back_office_am_name: string | null;
  };

  // `db.execute` hands bigints back as text; every money figure is converted
  // here, once, or two of them concatenate instead of adding.
  const rows = (result as unknown as Raw[]).map((r) => ({
    rank: Number(r.rank),
    id: r.id,
    name: r.name,
    phone: r.phone,
    city: r.city,
    thirdParty: r.third_party,
    place: r.place,
    salesAmName: r.sales_am_name,
    backOfficeAmName: r.back_office_am_name,
    orders: Number(r.orders),
    valuePaise: Number(r.value),
    lastOrderedOn: r.last_ordered_on,
    outstandingPaise: Number(r.outstanding),
  }));

  return {
    metric,
    limit,
    months,
    from: totals?.from_day ?? to,
    to,
    rows,
    companyCount: Number(totals?.top_count ?? 0),
    companyTopValuePaise: Number(totals?.top_value ?? 0),
    companyValuePaise: Number(totals?.all_value ?? 0),
    wholeCompany: ids === null,
  };
}
