import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { calls, customers, orders } from "@/db/schema";
import { assertCustomerInScope } from "../access-control";
import { getConfig } from "../config/store";
import { today } from "../recompute";
import {
  addDays,
  daysBetween,
  daysInMonth,
  isWorkingDay,
  startOfMonth,
  type BusinessDate,
} from "../business-date";

/* ---------------------------------------------------------------------------
 * §7 — everything the Information tab shows, in one operation.
 *
 * Two rules run through all of it:
 *
 *   Order Received records are NOT calls. They are excluded from "Last call"
 *   and from "Last 3 calls", because the section is about conversations and an
 *   order that arrived by WhatsApp was not one.
 *
 *   Run-rate maths counts WORKING days, not calendar days. A gap spread over
 *   the remaining Sundays is a number nobody can act on.
 * ------------------------------------------------------------------------- */

export type PurchaseSummary = {
  lastOrderDate: string | null;
  lastOrderDaysAgo: number | null;
  cycleDays: number;
  /** True when there was too little history to derive one, so it is a fallback. */
  cycleIsDefault: boolean;
  nextOrderDate: string | null;
  lastCallDate: string | null;
  lastCallDaysAgo: number | null;
};

export type MonthlyPerformance = {
  target: number;
  achieved: number;
  achievementPercent: number;
  gap: number;
  workingDaysRemaining: number;
  workingDaysElapsed: number;
  /** Gap ÷ working days left. What they must do per day from here. */
  requiredPerDay: number;
  /** Required per day − the pace they are actually running at. */
  shortfallPerDay: number;
};

export type RecentCall = {
  id: string;
  at: string;
  interactionType: "outbound_call" | "inbound_call";
  outcome: string | null;
  notes: string | null;
};

export type ProductHistoryRow = {
  productName: string;
  lastPurchaseDate: string | null;
  totalOrderCount: number;
};

export type CustomerInformation = {
  kind: "lead" | "customer";
  /** Set only on leads. */
  lead: {
    source: string | null;
    addedDate: string;
    ownerName: string | null;
  } | null;
  /** Set only on customers. */
  accountManagers: { sales: string | null; backOffice: string | null } | null;
  /**
   * Null on a lead. A record with no orders has no cycle, no run rate and no
   * target — showing zeroes would read as a customer performing badly rather
   * than as one who has not started.
   */
  purchase: PurchaseSummary | null;
  monthly: MonthlyPerformance | null;
  outstanding: number;
  creditDays: number;
  /** True when it fell back to the configured default. */
  creditDaysIsDefault: boolean;
  recentCalls: RecentCall[];
  productHistory: ProductHistoryRow[];
  /** Which system produced the product history, so the screen can say so. */
  productHistorySource: "external" | "crm";
  productHistorySyncedAt: string | null;
};

/**
 * Calendar days, per §13.7 — chosen once and applied to every "days ago"
 * figure on the tab, so two numbers side by side cannot use different rules.
 */
function daysAgo(from: string | null, day: BusinessDate): number | null {
  return from ? Math.max(0, daysBetween(from, day)) : null;
}

export async function customerInformation(
  customerId: string,
): Promise<CustomerInformation | null> {
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!customer) return null;
  await assertCustomerInScope(customer.ownerId);

  const isLead = customer.kind === "lead";

  const [names] = await db.execute<{
    owner: string | null;
    sales: string | null;
    back_office: string | null;
  }>(sql`
    select (select name from users where id = ${customer.ownerId}) as owner,
           (select name from users where id = ${customer.salesAmId}) as sales,
           (select name from users where id = ${customer.backOfficeAmId}) as back_office
  `);

  const config = await getConfig();
  const day = await today();
  const workingDay = {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  };

  /* ------------------------------------------------------ purchase summary */

  // Last CALL, not last interaction — an order that arrived by WhatsApp was
  // not a call, and this line sits under a heading that says "Last call".
  const [lastCall] = await db
    .select({ at: calls.startedAt })
    .from(calls)
    .where(
      and(
        eq(calls.customerId, customerId),
        sql`${calls.interactionType} in ('outbound_call','inbound_call')`,
      ),
    )
    .orderBy(desc(calls.startedAt))
    .limit(1);

  const lastCallDate = lastCall ? lastCall.at.toISOString().slice(0, 10) : null;

  const purchase: PurchaseSummary = {
    lastOrderDate: customer.lastOrderDate,
    lastOrderDaysAgo: daysAgo(customer.lastOrderDate, day),
    cycleDays: customer.cycleDays,
    cycleIsDefault: customer.cycleIsDefault,
    nextOrderDate: customer.lastOrderDate
      ? addDays(customer.lastOrderDate, customer.cycleDays)
      : null,
    lastCallDate,
    lastCallDaysAgo: daysAgo(lastCallDate, day),
  };

  /* ---------------------------------------------------- monthly performance */

  const [year, month] = day.split("-").map(Number);

  const [achievedRow] = await db
    .select({
      total: sql<number>`coalesce(sum(${orders.totalAmount}), 0)::bigint`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.customerId, customerId),
        sql`${orders.status} <> 'cancelled'`,
        sql`extract(year from ${orders.orderedAt}) = ${year}`,
        sql`extract(month from ${orders.orderedAt}) = ${month}`,
      ),
    );

  const [targetRow] = await db.execute<{ amount: number }>(sql`
    select coalesce(target_amount, 0)::bigint as amount from monthly_targets
     where customer_id = ${customerId} and year = ${year} and month = ${month}
  `);

  const achieved = Number(achievedRow?.total ?? 0);
  const target = Number(targetRow?.amount ?? 0);
  const gap = Math.max(0, target - achieved);

  // Working days, from configuration. Counted inclusive of today, because a
  // telecaller reading this at 10am still has today to work with.
  const monthStart = startOfMonth(day);
  const lastDay = `${day.slice(0, 8)}${String(daysInMonth(day)).padStart(2, "0")}`;

  let workingDaysRemaining = 0;
  for (let d = day; d <= lastDay; d = addDays(d, 1)) {
    if (isWorkingDay(d, workingDay)) workingDaysRemaining++;
  }
  let workingDaysElapsed = 0;
  for (let d = monthStart; d < day; d = addDays(d, 1)) {
    if (isWorkingDay(d, workingDay)) workingDaysElapsed++;
  }

  // On the last working day of the month the whole gap is due today, and on a
  // non-working day there is nothing left to divide by — guard both.
  const requiredPerDay =
    workingDaysRemaining > 0 ? Math.round(gap / workingDaysRemaining) : gap;
  const currentPace =
    workingDaysElapsed > 0 ? achieved / workingDaysElapsed : 0;
  const shortfallPerDay = Math.max(0, Math.round(requiredPerDay - currentPace));

  const monthly: MonthlyPerformance = {
    target,
    achieved,
    achievementPercent: target ? Math.round((achieved / target) * 100) : 0,
    gap,
    workingDaysRemaining,
    workingDaysElapsed,
    requiredPerDay,
    shortfallPerDay,
  };

  /* --------------------------------------------------------- last 3 calls */

  const recent = await db
    .select({
      id: calls.id,
      at: calls.startedAt,
      interactionType: calls.interactionType,
      outcome: calls.outcome,
      notes: calls.notes,
    })
    .from(calls)
    .where(
      and(
        eq(calls.customerId, customerId),
        sql`${calls.interactionType} in ('outbound_call','inbound_call')`,
      ),
    )
    .orderBy(desc(calls.startedAt))
    .limit(3);

  /* ------------------------------------------------------- product history */

  // The external order system is not connected, so this is derived from what
  // the CRM captured — and it says so rather than pretending to be the ERP.
  const productRows = await db.execute<{
    product_name: string;
    last_purchase: string | null;
    order_count: number;
  }>(sql`
    select p.name || coalesce(' — ' || p.pack_size, '') as product_name,
           max(c.started_at)::date::text as last_purchase,
           count(distinct c.order_id)::int as order_count
      from interaction_product_lines l
      join products p on p.id = l.product_id
      join calls c on c.id = l.interaction_id
     where c.customer_id = ${customerId} and c.order_id is not null
     group by 1
     order by order_count desc, last_purchase desc nulls last
  `);

  return {
    kind: customer.kind,
    lead: isLead
      ? {
          source: customer.leadSource,
          addedDate: customer.createdAt.toISOString().slice(0, 10),
          ownerName: names?.owner ?? null,
        }
      : null,
    accountManagers: isLead
      ? null
      : { sales: names?.sales ?? null, backOffice: names?.back_office ?? null },
    // A lead has no orders, so a cycle and a run rate would be zeroes dressed
    // up as performance.
    purchase: isLead ? null : purchase,
    monthly: isLead ? null : monthly,
    outstanding: customer.outstanding,
    creditDays: customer.creditDays ?? config["customers.defaultCreditDays"],
    creditDaysIsDefault: customer.creditDays === null,
    recentCalls: recent.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      interactionType: r.interactionType as "outbound_call" | "inbound_call",
      outcome: r.outcome,
      notes: r.notes,
    })),
    productHistory: productRows.map((r) => ({
      productName: r.product_name,
      lastPurchaseDate: r.last_purchase,
      totalOrderCount: Number(r.order_count),
    })),
    productHistorySource: "crm",
    productHistorySyncedAt: null,
  };
}
