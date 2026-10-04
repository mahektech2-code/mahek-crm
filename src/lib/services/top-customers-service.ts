import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { resolveScope, scopedUserIds, scopedToUsers } from "@/lib/access-control";
import { orderCountsSql, orderValueSql } from "@/lib/order-status";
import {
  BACK_OFFICE_AM_NAME_SQL,
  PLACE_NAMES_SQL,
  SALES_AM_NAME_SQL,
} from "@/lib/queries";
import type { PlaceNames } from "@/lib/place-filters";
import {
  TOP_CUSTOMER_SPANS,
  addMonthsKey,
  currentReportMonth,
  monthsCovered,
  type TopCustomerSpan,
} from "@/lib/top-customers-period";

/* ---------------------------------------------------------------------------
 * The company's top customers, and which of them are yours.
 *
 * GENERATED ON THE 1ST AT 10:00 IST, for three spans — 3, 6 and 12 whole
 * calendar months ending with the month just finished — and stored in
 * `top_customer_reports`. A report somebody works from for a month must not
 * move under them because a sheet reconcile edited an old order, so the
 * figures are frozen and only WHO SEES WHICH ROW is decided when it is read.
 *
 * THE RANKING IS COMPANY-WIDE, AND THE SCOPE ONLY DECIDES WHICH ROWS YOU SEE.
 * "Top 60 of my own book" would put a telecaller's sixtieth-best shop on a
 * list called Top customers. So the sixty are chosen across every book first,
 * each keeps its company rank, and THEN `scopedToUsers` — the narrowing the
 * Customers list runs — decides which of them this person is shown. An
 * admin's scope is the whole company and sees all sixty.
 *
 * "Did we sell anything" is `orderCountsSql` and "what was it worth" is
 * `orderValueSql`, so a pending or declined order never ranks anybody.
 * ------------------------------------------------------------------------- */

export type TopCustomerMetric = "value" | "orders";

export const TOP_CUSTOMER_METRICS: readonly TopCustomerMetric[] = ["value", "orders"];

/**
 * Generate the reports for `month` — all three spans — if they do not exist.
 *
 * IDEMPOTENT, and that is what lets three callers share it: the 10:00 cron,
 * the hourly pass that catches a missed one, and the screen itself when
 * somebody opens it before either has run. The report row is claimed with
 * `on conflict do nothing` inside the transaction that writes its rows, so two
 * callers racing cannot produce a report with half its customers or two
 * copies of one.
 */
export async function generateTopCustomerReports(month: string): Promise<{ generated: number[] }> {
  const generated: number[] = [];
  for (const span of TOP_CUSTOMER_SPANS) {
    const fromMonth = addMonthsKey(month, -span);
    const toMonth = addMonthsKey(month, -1);
    const id = `tcr_${randomUUID().slice(0, 12)}`;

    /*
     * The window's ends are midnights in the app's zone, named — a bare cast
     * reads them in the session's zone, which is not a property of the row.
     */
    const windowed = sql`
      orders o
      join customers c on c.id = o.customer_id
      where ${orderCountsSql("o")}
        and c.deleted_at is null
        and o.ordered_at >= ${`${fromMonth}-01`}::date::timestamp at time zone ${APP_TIMEZONE}
        and o.ordered_at <  ${`${month}-01`}::date::timestamp at time zone ${APP_TIMEZONE}`;

    const wrote = await db.transaction(async (tx) => {
      const claimed = (await tx.execute(sql`
        insert into top_customer_reports (id, month, span_months, from_month, to_month, total_paise)
        select ${id}, ${month}, ${span}::int, ${fromMonth}, ${toMonth},
               coalesce(sum(${orderValueSql("o")}), 0)::bigint
          from ${windowed}
        on conflict (month, span_months) do nothing
        returning id
      `)) as unknown as { id: string }[];
      if (!claimed.length) return false;

      await tx.execute(sql`
        with per as (
          select o.customer_id,
                 to_char(o.ordered_at at time zone ${APP_TIMEZONE}, 'YYYY-MM') as month,
                 sum(${orderValueSql("o")})::bigint as v,
                 count(*)::int as n
            from ${windowed}
           group by 1, 2
        ),
        m as (
          select to_char(gs, 'YYYY-MM') as month
            from generate_series(${`${fromMonth}-01`}::date,
                                 ${`${toMonth}-01`}::date,
                                 interval '1 month') gs
        )
        insert into top_customer_report_rows (id, report_id, customer_id, orders, value_paise, months)
        select 'tcrr_' || substr(md5(${id} || per.customer_id), 1, 16),
               ${id},
               per.customer_id,
               sum(per.n)::int,
               sum(per.v)::bigint,
               (select jsonb_agg(jsonb_build_object(
                         'month', m.month,
                         'valuePaise', coalesce(p2.v, 0),
                         'orders', coalesce(p2.n, 0)) order by m.month)
                  from m
                  left join per p2 on p2.customer_id = per.customer_id and p2.month = m.month)
          from per
         group by per.customer_id
      `);
      return true;
    });
    if (wrote) generated.push(span);
  }
  return { generated };
}

/** Generate this month's reports if 10:00 IST on the 1st has passed and they are missing. */
export async function ensureCurrentTopCustomerReports(atMs: number = Date.now()) {
  return generateTopCustomerReports(currentReportMonth(atMs, APP_TIMEZONE));
}

export type TopCustomerRow = {
  /** Where this account stands across the WHOLE company, not within the rows shown. */
  rank: number;
  id: string;
  name: string;
  location: string;
  thirdParty: boolean;
  salesAmName: string | null;
  backOfficeAmName: string | null;
  orders: number;
  valuePaise: number;
  months: { month: string; valuePaise: number; orders: number }[];
};

export type TopCustomersReport = {
  metric: TopCustomerMetric;
  span: TopCustomerSpan;
  /** The configured length of the company list. */
  limit: number;
  /** When this report was generated, ISO. Null only if generating it failed. */
  generatedAt: string | null;
  months: string[];
  /** Every approved order in the window, company-wide — what "contribution" divides by. */
  totalPaise: number;
  /** The rows this viewer may see, in company rank order. */
  rows: TopCustomerRow[];
  /** How many accounts made the company list — fewer than `limit` on a quiet book. */
  companyCount: number;
  companyTopValuePaise: number;
  /** True where the viewer's scope is the whole company, so every row is shown. */
  wholeCompany: boolean;
};

type Raw = {
  rank: number;
  orders: number;
  value_paise: string;
  months: { month: string; valuePaise: number | string; orders: number }[];
  id: string;
  name: string;
  city: string;
  third_party: boolean;
  place: PlaceNames | null;
  sales_am_name: string | null;
  back_office_am_name: string | null;
};

/**
 * This month's stored report for a span, generating it first if it is due and
 * missing. Both tabs that read the report — Top customers and Focus customers
 * — come through here, so they always describe the same months.
 */
export async function currentTopCustomerReport(span: TopCustomerSpan): Promise<{
  month: string;
  report: { id: string; total_paise: string; generated_at: string } | undefined;
}> {
  const month = currentReportMonth(Date.now(), APP_TIMEZONE);
  // The screen is the last of the three callers, so it is never empty because
  // a cron line is missing from a crontab.
  await generateTopCustomerReports(month);
  const [report] = (await db.execute(sql`
    select id, total_paise::text as total_paise,
           to_char(generated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as generated_at
      from top_customer_reports
     where month = ${month} and span_months = ${span}::int
  `)) as unknown as { id: string; total_paise: string; generated_at: string }[];
  return { month, report };
}

export async function topCustomersReport(
  span: TopCustomerSpan,
  metric: TopCustomerMetric,
): Promise<TopCustomersReport> {
  const { month, report } = await currentTopCustomerReport(span);

  const [ctx, config] = await Promise.all([resolveScope(), getConfig()]);
  const ids = scopedUserIds(ctx.scope);
  const limit = config["topCustomers.count"];

  // A tiebreaker in every ordering, or a rank could change between two loads.
  const order =
    metric === "orders"
      ? sql`r.orders desc, r.value_paise desc, r.customer_id`
      : sql`r.value_paise desc, r.orders desc, r.customer_id`;

  const result = report
    ? ((await db.execute(sql`
        with ranked as (
          select r.*, row_number() over (order by ${order})::int as rank
            from top_customer_report_rows r
           where r.report_id = ${report.id}
        ),
        top as (select * from ranked where rank <= ${limit}::int)
        select top.rank,
               top.orders,
               top.value_paise::text as value_paise,
               top.months,
               customers.id,
               customers.name,
               customers.city,
               customers.third_party,
               ${PLACE_NAMES_SQL} as place,
               ${SALES_AM_NAME_SQL} as sales_am_name,
               ${BACK_OFFICE_AM_NAME_SQL} as back_office_am_name
          from top
          join customers on customers.id = top.customer_id
         where ${scopedToUsers(ids)}
         order by top.rank
      `)) as unknown as Raw[])
    : [];

  // A viewer with none of the sixty still needs the company figures for the
  // sentence that says so.
  const [company] = report
    ? ((await db.execute(sql`
        with top as (
          select r.value_paise from top_customer_report_rows r
           where r.report_id = ${report.id}
           order by ${order}
           limit ${limit}::int
        )
        select count(*)::int as n, coalesce(sum(value_paise), 0)::text as v from top
      `)) as unknown as { n: number; v: string }[])
    : [];

  return {
    metric,
    span,
    limit,
    generatedAt: report?.generated_at ?? null,
    months: monthsCovered(month, span),
    totalPaise: Number(report?.total_paise ?? 0),
    // `db.execute` hands bigints back as text; converted here, once, or two of
    // them concatenate instead of adding.
    rows: result.map((r) => ({
      rank: Number(r.rank),
      id: r.id,
      name: r.name,
      location: r.place?.city ?? r.city,
      thirdParty: r.third_party,
      salesAmName: r.sales_am_name,
      backOfficeAmName: r.back_office_am_name,
      orders: Number(r.orders),
      valuePaise: Number(r.value_paise),
      months: r.months.map((m) => ({
        month: m.month,
        valuePaise: Number(m.valuePaise),
        orders: Number(m.orders),
      })),
    })),
    companyCount: Number(company?.n ?? 0),
    companyTopValuePaise: Number(company?.v ?? 0),
    wholeCompany: ids === null,
  };
}
