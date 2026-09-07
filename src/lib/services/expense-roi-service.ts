import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { expenseMonthSnapshots } from "@/db/schema";
import { APP_TIMEZONE, endOfMonth } from "@/lib/business-date";
import { orderCountsSql } from "@/lib/order-status";
import { creditedToSql } from "@/lib/sales-attribution";
import {
  coca,
  customerReturn,
  rank,
  servicingCost,
  splitSpend,
  type RankedSalesman,
  type SalesmanPeriod,
  type SpendItem,
} from "@/lib/engines/sales-roi";
import { managerScope, onlyMine } from "./sales-service";

/* ---------------------------------------------------------------------------
 * §K and §L, wired to the book.
 *
 * Two rules run through the whole file and neither is negotiable:
 *
 * **Cost is APPROVED expenses, never claimed.** Money the business has agreed
 * to pay is the only cost figure that means anything — the same rule the
 * payments module follows for reported against confirmed money. A cost built
 * from claims moves every time somebody submits one and moves back when it is
 * refused, and no two readings of a month would ever agree.
 *
 * **Revenue is APPROVED orders**, through `orderCountsSql`, which is the
 * one definition of "did we sell anything" in this product. A pending order is
 * the customer saying yes; it is not a sale.
 * ------------------------------------------------------------------------- */

export type SalesmanRoiRow = RankedSalesman & { employeeStatus: string | null };

/**
 * Every salesman's period, in one query.
 *
 * The expense figures come from `mbos_expenses` joined to the APPROVED
 * approval on its day — so a day still waiting on a manager contributes
 * nothing to cost, which is correct and is also why a fresh month reads low
 * until the approvals catch up. The screen says so rather than leaving
 * somebody to wonder.
 */
export async function salesmanPeriods(from: string, to: string): Promise<SalesmanPeriod[]> {
  const scope = await managerScope();
  return db.execute<SalesmanPeriod>(sql`
    with approved_days as (
      select d.id, d.user_id, d.day
        from mbos_expense_days d
        join mbos_approvals a
          on a.subject_type = 'mbos_expense_days' and a.subject_id = d.id
       where a.state in ('approved', 'partially_approved')
         and d.day between ${from}::date and ${to}::date
    ),
    spend as (
      select ad.user_id,
             coalesce(sum(e.eligible_paise) filter (where e.kind = 'travel'), 0) as travel,
             coalesce(sum(e.eligible_paise) filter (where e.kind = 'food'), 0) as food,
             coalesce(sum(e.eligible_paise) filter (where e.kind = 'lodging'), 0) as lodging,
             coalesce(sum(e.eligible_paise) filter (
               where e.kind not in ('travel', 'food', 'lodging')), 0) as other
        from approved_days ad
        join mbos_expenses e on e.expense_day_id = ad.id and e.superseded_by_id is null
       group by ad.user_id
    ),
    distance as (
      select ad.user_id, coalesce(sum(l.chosen_metres), 0)::int as metres
        from approved_days ad
        join mbos_travel_legs l on l.expense_day_id = ad.id
       group by ad.user_id
    )
    select u.id as "userId", u.name,
           /* Whose revenue this is comes from sales-attribution.ts and
              nowhere else. Two readings of "who gets credited" is how the
              Sales Dashboard and this screen come to quote one salesman two
              different numbers -- and the orders table carries no salesman of
              its own, because the credit is a fact about the CUSTOMER. */
           coalesce((select sum(o.total_amount) from orders o
                      join customers oc on oc.id = o.customer_id
                      where ${creditedToSql("oc")} = u.id
                        and ${orderCountsSql("o")}
                        and (o.ordered_at at time zone ${APP_TIMEZONE})::date
                            between ${from}::date and ${to}::date), 0) as "revenuePaise",
           coalesce(d.metres, 0) as metres,
           (select count(*)::int from mbos_visits v
             where v.salesman_id = u.id
               and (v.check_in_at at time zone ${APP_TIMEZONE})::date
                   between ${from}::date and ${to}::date) as "visitCount",
           /* A customer is won ONCE — the first counting order ever, not the
              first one inside the window. Asking the window would call an
              account of four years "new" the month somebody reordered. */
           (select count(*)::int from (
              select o2.customer_id, min((o2.ordered_at at time zone ${APP_TIMEZONE})::date) as first_day
                from orders o2
                join customers oc2 on oc2.id = o2.customer_id
               where ${creditedToSql("oc2")} = u.id
                 and ${orderCountsSql("o2")}
               group by o2.customer_id
            ) firsts where firsts.first_day between ${from}::date and ${to}::date)
             as "newCustomerCount",
           coalesce(s.travel, 0) as "travelPaise",
           coalesce(s.food, 0) as "foodPaise",
           coalesce(s.lodging, 0) as "lodgingPaise",
           coalesce(s.other, 0) as "otherPaise",
           e.net_salary_paise as "salaryPaise"
      from users u
      join app_access a on a.user_id = u.id and a.app = 'field'
      left join spend s on s.user_id = u.id
      left join distance d on d.user_id = u.id
      /* Email then company mobile — the same match payForPeriod uses, so the
         salary here and the salary on the Salary screen cannot differ. */
      left join employees e
             on lower(e.email) = lower(u.email)
             or (e.company_mobile is not null and e.company_mobile = u.phone)
     where u.active ${onlyMine(scope, "u.id")}
     order by u.name asc
  `);
}

export async function salesmanRoi(
  from: string,
  to: string,
  marginBps?: number | null,
): Promise<RankedSalesman[]> {
  return rank(await salesmanPeriods(from, to), marginBps);
}

/* ---------------------------------------------------- §L acquisition split */

/**
 * Every piece of approved spending in the period, with the one fact that
 * decides which side of §L's line it falls: had that customer ordered before?
 *
 * Asked in SQL rather than per item, because "before this leg" is a different
 * date for every row and a service loop would be one query per leg.
 */
export async function spendItems(from: string, to: string): Promise<SpendItem[]> {
  const scope = await managerScope();
  return db.execute<SpendItem>(sql`
    with approved_days as (
      select d.id, d.user_id, d.day
        from mbos_expense_days d
        join mbos_approvals a
          on a.subject_type = 'mbos_expense_days' and a.subject_id = d.id
       where a.state in ('approved', 'partially_approved')
         and d.day between ${from}::date and ${to}::date
    )
    select l.id,
           coalesce((select e.eligible_paise from mbos_expenses e
                      where e.source_type = 'travel_leg' and e.source_id = l.id
                      limit 1), 0) as paise,
           l.purpose,
           l.customer_id as "customerId",
           case when l.customer_id is null then null
                else exists (
                  select 1 from orders o
                   where o.customer_id = l.customer_id
                     and ${orderCountsSql("o")}
                     and (o.ordered_at at time zone ${APP_TIMEZONE})::date < ad.day
                ) end as "customerHadOrderedBefore"
      from approved_days ad
      join mbos_travel_legs l on l.expense_day_id = ad.id
      join users u on u.id = ad.user_id
     where true ${onlyMine(scope, "u.id")}
  `);
}

export type CustomerCostSummary = {
  acquisition: ReturnType<typeof coca>;
  servicing: ReturnType<typeof servicingCost>;
  unattributedPaise: number;
  newCustomers: number;
  customersServed: number;
};

/**
 * Requirements 62 to 65.
 *
 * The two costs are worked out from ONE split, in one place, because two
 * readings of "was this about winning a customer" is how the two figures come
 * to overlap — and once they overlap the acquisition cost is flattered by
 * whatever servicing leaked into it and neither number is worth anything.
 */
export async function customerCosts(from: string, to: string): Promise<CustomerCostSummary> {
  const items = await spendItems(from, to);
  const split = splitSpend(items);

  const [counts] = await db.execute<{ newCustomers: number; customersServed: number }>(sql`
    select
      (select count(*)::int from (
         select o.customer_id, min((o.ordered_at at time zone ${APP_TIMEZONE})::date) as first_day
           from orders o
          where ${orderCountsSql("o")}
          group by o.customer_id
       ) f where f.first_day between ${from}::date and ${to}::date) as "newCustomers",
      (select count(distinct l.customer_id)::int
         from mbos_travel_legs l
         join mbos_expense_days d on d.id = l.expense_day_id
        where l.customer_id is not null
          and d.day between ${from}::date and ${to}::date) as "customersServed"
  `);

  return {
    acquisition: coca(split.acquisitionPaise, counts?.newCustomers ?? 0),
    servicing: servicingCost(split.servicingPaise, counts?.customersServed ?? 0),
    unattributedPaise: split.unattributedPaise,
    newCustomers: counts?.newCustomers ?? 0,
    customersServed: counts?.customersServed ?? 0,
  };
}

/* ------------------------------------------------------------ §M breakdown */

export type ExpenseBreakdown = {
  travelPaise: number;
  foodPaise: number;
  lodgingPaise: number;
  localTransportPaise: number;
  otherPaise: number;
  totalPaise: number;
  /** Claimed but not yet decided. Named, so a low month is not read as a cheap one. */
  awaitingPaise: number;
};

/** Requirements 66 and 67. */
export async function expenseBreakdown(from: string, to: string): Promise<ExpenseBreakdown> {
  const scope = await managerScope();
  const [row] = await db.execute<ExpenseBreakdown>(sql`
    select
      coalesce(sum(e.eligible_paise) filter (
        where e.kind = 'travel' and a.state in ('approved','partially_approved')), 0) as "travelPaise",
      coalesce(sum(e.eligible_paise) filter (
        where e.kind = 'food' and a.state in ('approved','partially_approved')), 0) as "foodPaise",
      coalesce(sum(e.eligible_paise) filter (
        where e.kind = 'lodging' and a.state in ('approved','partially_approved')), 0) as "lodgingPaise",
      coalesce(sum(e.eligible_paise) filter (
        where e.kind = 'local_transport' and a.state in ('approved','partially_approved')), 0)
        as "localTransportPaise",
      coalesce(sum(e.eligible_paise) filter (
        where e.kind = 'other' and a.state in ('approved','partially_approved')), 0) as "otherPaise",
      coalesce(sum(e.eligible_paise) filter (
        where a.state in ('approved','partially_approved')), 0) as "totalPaise",
      coalesce(sum(e.amount_paise) filter (where a.state = 'pending' or a.state is null), 0)
        as "awaitingPaise"
      from mbos_expense_days d
      join users u on u.id = d.user_id
      join mbos_expenses e on e.expense_day_id = d.id and e.superseded_by_id is null
      left join mbos_approvals a
        on a.subject_type = 'mbos_expense_days' and a.subject_id = d.id and a.step_index = 0
     where d.day between ${from}::date and ${to}::date
       ${onlyMine(scope, "u.id")}
  `);
  return (
    row ?? {
      travelPaise: 0,
      foodPaise: 0,
      lodgingPaise: 0,
      localTransportPaise: 0,
      otherPaise: 0,
      totalPaise: 0,
      awaitingPaise: 0,
    }
  );
}

export { customerReturn };


/* --------------------------------------------------- §M72 the monthly trend */

/**
 * Freeze one month.
 *
 * Called by the nightly pass for the CURRENT month only, so a closed month
 * stops being rewritten the day it closes and no job has to fire on exactly
 * the right date. Nothing here rewrites a past month and nothing may learn to:
 * a rebuild would destroy the one thing this table exists for.
 *
 * It writes a row per salesman AND a company row with a null user. The company
 * row is not the sum of the others where a person has since been deactivated —
 * so it is computed as its own total rather than added up afterwards.
 */
export async function snapshotExpenseMonth(period: string): Promise<number> {
  const from = `${period}-01`;
  const to = endOfMonth(period);

  const people = await salesmanPeriods(from, to);
  const breakdown = await expenseBreakdown(from, to);

  const rows = people.map((p) => ({
    id: `xms_${period}_${p.userId.slice(-16)}`,
    period,
    userId: p.userId,
    travelPaise: Number(p.travelPaise),
    foodPaise: Number(p.foodPaise),
    lodgingPaise: Number(p.lodgingPaise),
    localTransportPaise: 0,
    otherPaise: Number(p.otherPaise),
    awaitingPaise: 0,
    revenuePaise: Number(p.revenuePaise),
    metres: Number(p.metres),
    visitCount: p.visitCount,
    newCustomerCount: p.newCustomerCount,
    salesmanCount: 1,
    computedAt: new Date(),
  }));

  rows.push({
    id: `xms_${period}_company`,
    period,
    userId: null as unknown as string,
    travelPaise: Number(breakdown.travelPaise),
    foodPaise: Number(breakdown.foodPaise),
    lodgingPaise: Number(breakdown.lodgingPaise),
    localTransportPaise: Number(breakdown.localTransportPaise),
    otherPaise: Number(breakdown.otherPaise),
    awaitingPaise: Number(breakdown.awaitingPaise),
    revenuePaise: people.reduce((n, p) => n + Number(p.revenuePaise), 0),
    metres: people.reduce((n, p) => n + Number(p.metres), 0),
    visitCount: people.reduce((n, p) => n + p.visitCount, 0),
    newCustomerCount: people.reduce((n, p) => n + p.newCustomerCount, 0),
    salesmanCount: people.length,
    computedAt: new Date(),
  });

  for (const row of rows) {
    await db
      .insert(expenseMonthSnapshots)
      .values(row)
      .onConflictDoUpdate({
        target: [expenseMonthSnapshots.period, expenseMonthSnapshots.userId],
        set: { ...row, computedAt: new Date() },
      });
  }
  return rows.length;
}

export type TrendPoint = {
  period: string;
  travelPaise: number;
  foodPaise: number;
  lodgingPaise: number;
  localTransportPaise: number;
  otherPaise: number;
  totalPaise: number;
  revenuePaise: number;
  metres: number;
  visitCount: number;
  salesmanCount: number;
  /** Basis points of revenue. Null where nothing was sold — never infinity. */
  expenseRatioBps: number | null;
};

/**
 * The last N months, company-wide.
 *
 * Reads the SNAPSHOT and never the ledger, which is the whole point — a month
 * that has closed reads the same on every load, and a correction to an old
 * claim does not silently redraw a chart the owner made a decision from.
 *
 * A month with no snapshot is ABSENT rather than zero. The screen says so:
 * before this table existed there is no honest figure, and drawing a zero
 * would show a cost reduction that never happened.
 */
export async function expenseTrend(months: number): Promise<TrendPoint[]> {
  const rows = await db.execute<Omit<TrendPoint, "totalPaise" | "expenseRatioBps">>(sql`
    select period,
           travel_paise as "travelPaise", food_paise as "foodPaise",
           lodging_paise as "lodgingPaise",
           local_transport_paise as "localTransportPaise",
           other_paise as "otherPaise",
           revenue_paise as "revenuePaise", metres,
           visit_count as "visitCount", salesman_count as "salesmanCount"
      from expense_month_snapshots
     where user_id is null
     order by period desc
     limit ${months}
  `);

  return rows
    .map((r) => {
      const total =
        Number(r.travelPaise) +
        Number(r.foodPaise) +
        Number(r.lodgingPaise) +
        Number(r.localTransportPaise) +
        Number(r.otherPaise);
      return {
        ...r,
        travelPaise: Number(r.travelPaise),
        foodPaise: Number(r.foodPaise),
        lodgingPaise: Number(r.lodgingPaise),
        localTransportPaise: Number(r.localTransportPaise),
        otherPaise: Number(r.otherPaise),
        revenuePaise: Number(r.revenuePaise),
        metres: Number(r.metres),
        totalPaise: total,
        expenseRatioBps:
          Number(r.revenuePaise) > 0
            ? Math.round((total / Number(r.revenuePaise)) * 10_000)
            : null,
      };
    })
    .reverse();
}
