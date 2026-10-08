import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { resolveScope, scopedUserIds, scopedToUsers } from "@/lib/access-control";
import { isManager, requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import {
  BACK_OFFICE_AM_NAME_SQL,
  PLACE_NAMES_SQL,
  SALES_AM_NAME_SQL,
} from "@/lib/queries";
import type { PlaceNames } from "@/lib/place-filters";
import { monthsCovered, type TopCustomerSpan } from "@/lib/top-customers-period";
import { currentTopCustomerReport } from "@/lib/services/top-customers-service";

/* ---------------------------------------------------------------------------
 * Focus customers — the ones somebody has said need attention to become top
 * customers. Any customer in the reader's book can be added, a new account
 * with one order as readily as one sitting just outside the top sixty.
 *
 * THE FIGURES ARE THE TOP CUSTOMERS REPORT'S, never a second reading. Each
 * row is looked up in the same stored report that tab draws, ranked the same
 * way across the whole company, so "#84, ₹2.1L short of the top 60" here and
 * the list on the next tab cannot disagree. An account that bought nothing in
 * the window is simply absent from the report: zero, unranked, and the whole
 * cutoff short.
 *
 * Who sees an entry is the customer's scope, as everywhere else — so a back
 * office telecaller sees the focus customers in their own book whoever added
 * them, and an admin sees all of them.
 * ------------------------------------------------------------------------- */

export type FocusCustomerRow = {
  entryId: string;
  id: string;
  name: string;
  location: string;
  thirdParty: boolean;
  salesAmName: string | null;
  backOfficeAmName: string | null;
  note: string | null;
  addedByName: string | null;
  addedAt: string;
  /** The company rank by sales in the report, or null where nothing was bought. */
  rank: number | null;
  orders: number;
  valuePaise: number;
  months: { month: string; valuePaise: number; orders: number }[];
  /** What it would take to reach the cutoff — null where already inside it. */
  gapPaise: number | null;
  lastOrderDate: string | null;
  outstandingPaise: number;
  /** The person who added it, or a manager. */
  canRemove: boolean;
};

export type FocusCustomers = {
  span: TopCustomerSpan;
  limit: number;
  months: string[];
  /** Sales of the customer at the cutoff, null when fewer than `limit` bought anything. */
  cutoffPaise: number | null;
  /** How many customers bought anything in the window — the denominator of a rank. */
  rankedCount: number;
  rows: FocusCustomerRow[];
};

type Raw = {
  entry_id: string;
  note: string | null;
  added_at: string;
  added_by_id: string | null;
  added_by_name: string | null;
  id: string;
  name: string;
  city: string;
  third_party: boolean;
  place: PlaceNames | null;
  sales_am_name: string | null;
  back_office_am_name: string | null;
  last_order_date: string | null;
  outstanding: string;
  rank: number | null;
  orders: number | null;
  value_paise: string | null;
  months: { month: string; valuePaise: number | string; orders: number }[] | null;
  cutoff: string | null;
  ranked_count: number;
};

export async function focusCustomers(span: TopCustomerSpan): Promise<FocusCustomers> {
  const [user, ctx, config, { month, report }] = await Promise.all([
    requireUser(),
    resolveScope(),
    getConfig(),
    currentTopCustomerReport(span),
  ]);
  const ids = scopedUserIds(ctx.scope);
  const limit = config["topCustomers.count"];
  const months = monthsCovered(month, span);
  const manager = isManager(user);

  const rows = (await db.execute(sql`
    with ranked as (
      select r.customer_id, r.orders, r.value_paise, r.months,
             row_number() over (order by r.value_paise desc, r.orders desc, r.customer_id)::int as rank
        from top_customer_report_rows r
       where r.report_id = ${report?.id ?? ""}
    )
    select f.id as entry_id,
           f.note,
           to_char(f.added_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as added_at,
           f.added_by_id,
           (select u.name from users u where u.id = f.added_by_id) as added_by_name,
           customers.id,
           customers.name,
           customers.city,
           customers.third_party,
           ${PLACE_NAMES_SQL} as place,
           ${SALES_AM_NAME_SQL} as sales_am_name,
           ${BACK_OFFICE_AM_NAME_SQL} as back_office_am_name,
           customers.last_order_date::text as last_order_date,
           customers.outstanding::text as outstanding,
           ranked.rank,
           ranked.orders,
           ranked.value_paise::text as value_paise,
           ranked.months,
           (select x.value_paise::text from ranked x where x.rank = ${limit}::int) as cutoff,
           (select count(*)::int from ranked) as ranked_count
      from focus_customers f
      join customers on customers.id = f.customer_id
      left join ranked on ranked.customer_id = f.customer_id
     where ${scopedToUsers(ids)}
     order by coalesce(ranked.rank, 2147483647), customers.name
  `)) as unknown as Raw[];

  // `db.execute` hands bigints back as text, so every money figure is
  // converted here, once.
  const cutoff = rows[0]?.cutoff != null ? Number(rows[0].cutoff) : null;
  return {
    span,
    limit,
    months,
    cutoffPaise: cutoff,
    rankedCount: Number(rows[0]?.ranked_count ?? 0),
    rows: rows.map((r) => {
      const value = Number(r.value_paise ?? 0);
      const rank = r.rank == null ? null : Number(r.rank);
      const inside = rank != null && (rank <= limit || cutoff == null);
      return {
        entryId: r.entry_id,
        id: r.id,
        name: r.name,
        location: r.place?.city ?? r.city,
        thirdParty: r.third_party,
        salesAmName: r.sales_am_name,
        backOfficeAmName: r.back_office_am_name,
        note: r.note,
        addedByName: r.added_by_name,
        addedAt: r.added_at,
        rank,
        orders: Number(r.orders ?? 0),
        valuePaise: value,
        months: r.months
          ? r.months.map((m) => ({
              month: m.month,
              valuePaise: Number(m.valuePaise),
              orders: Number(m.orders),
            }))
          : months.map((m) => ({ month: m, valuePaise: 0, orders: 0 })),
        // With fewer than `limit` customers buying at all, anybody who bought
        // is on the list and there is no cutoff to fall short of.
        gapPaise: inside ? null : cutoff != null ? Math.max(cutoff - value, 0) : null,
        lastOrderDate: r.last_order_date,
        outstandingPaise: Number(r.outstanding),
        canRemove: manager || r.added_by_id === user.id,
      };
    }),
  };
}
