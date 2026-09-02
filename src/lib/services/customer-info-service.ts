import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { orderCountsSql } from "../order-status";
import { bills, calls, customers, orders } from "@/db/schema";
import { assertCustomerInScope } from "../access-control";
import { getConfig } from "../config/store";
import { customerProducts, type FrequentProduct } from "./product-service";
import { nextStepForCustomer } from "./queue-service";
import { today } from "../recompute";
import {
  addDays,
  businessDate,
  calendarDate,
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
  recentCalls: RecentCall[];
  /** Newest first — what the Request CN bill picker offers. */
  bills: Array<{ id: string; billNo: string; billDate: string }>;
  productHistory: ProductHistoryRow[];
  /** §2.1 — the order form's quick-pick container, same aggregation. */
  frequentProducts: FrequentProduct[];
  /** Which system produced the product history, so the screen can say so. */
  productHistorySource: "external" | "crm";
  productHistorySyncedAt: string | null;
  /**
   * Set only where a pending reminder is standing behind an earlier reason
   * the system would otherwise surface first — see `NextStep["promise"]`.
   * This is the SAME live read the post-save confirmation dialog uses, so a
   * conflict already showing here and a hold offered there can never
   * disagree about what the promise actually is.
   */
  pendingHold: { headline: string; detail: string; reminderId: string; dueDate: string } | null;
};

/**
 * Calendar days, per §13.7 — chosen once and applied to every "days ago"
 * figure on the tab, so two numbers side by side cannot use different rules.
 */
/*
 * `from` must be a BUSINESS date, like `day`. The clamp below is why this
 * needed saying out loud: a calendar date one day ahead produced minus one,
 * `Math.max` turned that into a confident "0 days ago", and the date printed
 * beside it disagreed with the queue about which day the call happened on.
 */
function daysAgo(from: BusinessDate | null, day: BusinessDate): number | null {
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
  await assertCustomerInScope(customer);

  const isLead = customer.kind === "lead";

  const [names] = await db.execute<{
    owner: string | null;
    sales: string | null;
    back_office: string | null;
  }>(sql`
    select (select name from users where id = ${customer.ownerId}) as owner,
           -- The Sales Person the customer master names, falling back to a
           -- linked account. Most of those names have no account at all.
           coalesce(
             ${customer.salesPersonName},
             (select name from users where id = ${customer.salesAmId})
           ) as sales,
           -- The account first, the sheet's name second. See queries.ts: the
           -- two sides coalesce in opposite orders on purpose.
           coalesce(
             (select name from users where id = ${customer.backOfficeAmId}),
             ${customer.backOfficeName}
           ) as back_office
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

  /*
   * A BUSINESS date, not a calendar one, because it is shown beside `day` and
   * subtracted from it below. A call at 1am belongs to the shift that started
   * the previous morning — which is what the queue already believes, and the
   * Information tab used to contradict it for the five hours before the day
   * boundary. The compiler enforces the pairing now: `daysAgo` will not take
   * a calendar date.
   */
  const lastCallDate = lastCall ? businessDate(lastCall.at, workingDay) : null;

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
        orderCountsSql("orders"),
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

  /* ------------------------------------------------------------- the bills */

  // A credit note asked for mid-call has to name the bill it is against, so
  // the panel needs the list the moment the complaint form opens — a second
  // trip while the customer is still on the line is a trip too many.
  const customerBills = await db
    .select({
      id: bills.id,
      billNo: bills.billNo,
      billDate: bills.billDate,
    })
    .from(bills)
    .where(eq(bills.customerId, customerId))
    .orderBy(desc(bills.billDate))
    .limit(50);

  /* ------------------------------------------------------- product history */

  // §2.1 — one aggregation serves the Information tab and the order form's
  // quick-pick container, so the two cannot describe the same customer
  // differently. Limit 0 means the whole history; the form asks for fewer.
  const config2 = await getConfig();
  const allProducts = await customerProducts(customerId, { limit: 0 });
  const frequent = allProducts.slice(0, config2["products.frequentCount"]);

  /*
   * Whether this customer is ALREADY in the state that prompted the hold
   * action: a pending reminder standing behind an earlier reason. Read
   * before any new call is logged, so the offer to hold reaches a customer
   * whose conflict predates this feature, not only a freshly-made promise.
   * Failing to work it out must not fail the rest of the tab.
   */
  let pendingHold: CustomerInformation["pendingHold"] = null;
  try {
    const step = await nextStepForCustomer(customerId);
    if (step?.promise) {
      pendingHold = {
        headline: step.headline,
        detail: step.detail,
        reminderId: step.promise.reminderId,
        dueDate: step.promise.dueDate,
      };
    }
  } catch {
    pendingHold = null;
  }

  return {
    kind: customer.kind,
    lead: isLead
      ? {
          source: customer.leadSource,
          addedDate: calendarDate(customer.createdAt),
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
    recentCalls: recent.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      interactionType: r.interactionType as "outbound_call" | "inbound_call",
      outcome: r.outcome,
      notes: r.notes,
    })),
    bills: customerBills,
    productHistory: allProducts.map((r) => ({
      productName: r.displayName,
      lastPurchaseDate: r.lastPurchaseDate,
      totalOrderCount: r.totalOrderCount,
    })),
    frequentProducts: frequent,
    productHistorySource: "crm",
    productHistorySyncedAt: null,
    pendingHold,
  };
}
