import "server-only";
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import type { BusinessDate, DateRange } from "@/lib/business-date";
import { monthKey } from "@/lib/business-date";
import { orderCountsSql } from "@/lib/order-status";
import { creditedToSql } from "@/lib/sales-attribution";
import { resolveScope, scopedUserIds } from "@/lib/access-control";
import {
  bandFor,
  type HealthBand,
} from "@/lib/engines/inactivity";
import {
  billSize,
  changeInCount,
  changeInRate,
  conversionFor,
  frequency,
  movement,
  ownerAlerts,
  retention,
  type BillSize,
  type Change,
  type Conversion,
  type Frequency,
  type LeadRow,
  type Movement,
  type OwnerAlert,
  type Retention,
} from "@/lib/engines/owner-kpis";

/* ---------------------------------------------------------------------------
 * The owner's five, read off the book.
 *
 * `lib/engines/owner-kpis.ts` decides what the five MEAN; this decides what the
 * numbers are. Every figure comes from the same places the rest of the product
 * reads — orders that count as purchases, receipts accounts have confirmed,
 * the buying cycle the Call Log already times its calls from — because the
 * point of putting this dashboard on the same database is that the owner and
 * the telecaller cannot be told two different things about one customer.
 *
 * Nothing here defines a threshold. The bands are `engines/inactivity.ts`, the
 * purchase statuses are `order-status.ts`, and whose customer it is is
 * `sales-attribution.ts`. A reporting layer that re-answers those questions is
 * how a dashboard comes to disagree with the app it reports on.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* ------------------------------------------------------------------ filters */

export type OwnerFilters = {
  /** The person a customer's figures are credited to — see `sales-attribution`. */
  salesmanId?: string;
  salesManagerId?: string;
  /** `customers.region`. The nearest thing this book has to a state. */
  region?: string;
  city?: string;
  customerType?: string;
  /** An account that bills for others — `customer_distributors`. */
  distributorId?: string;
  customerId?: string;
};

/**
 * The filters, as a clause on a `customers` alias.
 *
 * SCOPE IS APPLIED TOO, and deliberately. The Reports app is the owner's, but
 * a manager granted it must not quietly see the whole company through it —
 * every other list in this product narrows the same way, and a reporting
 * screen that does not is a way around the narrowing rather than a report.
 */
export async function ownerFilterClause(
  filters: OwnerFilters,
  alias = "c",
): Promise<SQL> {
  const ctx = await resolveScope();
  const parts: SQL[] = [sql`true`];

  // `scopedToUsers` is written against the literal table name `customers`, so
  // it is only usable where the alias IS that. Everything here aliases to `c`,
  // so the same rule is re-expressed rather than borrowed — and it is the ONE
  // place in this file that happens, with the clause below kept in step by
  // hand rather than by hope.
  const ids = scopedUserIds(ctx.scope);
  if (ids) {
    const list = sql.join(
      ids.map((i: string) => sql`${i}`),
      sql`, `,
    );
    parts.push(
      sql`(${sql.raw(`${alias}.sales_am_id`)} in (${list})
           or ${sql.raw(`${alias}.owner_id`)} in (${list})
           or ${sql.raw(`${alias}.back_office_am_id`)} in (${list}))`,
    );
  }

  if (filters.salesmanId) {
    parts.push(sql`${creditedToSql(alias)} = ${filters.salesmanId}`);
  }
  if (filters.salesManagerId) {
    parts.push(sql`${sql.raw(`${alias}.sales_manager_id`)} = ${filters.salesManagerId}`);
  }
  if (filters.region) {
    parts.push(sql`${sql.raw(`${alias}.region`)} = ${filters.region}`);
  }
  if (filters.city) {
    parts.push(sql`${sql.raw(`${alias}.city`)} = ${filters.city}`);
  }
  if (filters.customerType) {
    parts.push(sql`${sql.raw(`${alias}.customer_type`)} = ${filters.customerType}`);
  }
  if (filters.customerId) {
    parts.push(sql`${sql.raw(`${alias}.id`)} = ${filters.customerId}`);
  }
  if (filters.distributorId) {
    parts.push(sql`exists (
      select 1 from customer_distributors cd
       where cd.customer_id = ${sql.raw(`${alias}.id`)}
         and cd.distributor_customer_id = ${filters.distributorId}
    )`);
  }

  return sql.join(parts, sql` and `);
}

/**
 * A day window with its zone named.
 *
 * Without the `+05:30` Postgres reads the bounds in the SESSION's zone, and
 * the session is not a property of the row — an order at 9am on the 1st falls
 * outside the month on a connection left in UTC. Local Postgres runs in
 * Asia/Kolkata and agrees with itself, so this is invisible in development and
 * wrong in production, which is the trap the rule exists for.
 */
function windowOf(range: DateRange) {
  return {
    start: sql.raw(`'${range.from} 00:00:00+05:30'::timestamptz`),
    end: sql.raw(`'${range.to} 23:59:59.999+05:30'::timestamptz`),
    fromDate: sql.raw(`'${range.from}'::date`),
    toDate: sql.raw(`'${range.to}'::date`),
  };
}

/* ------------------------------------------------------ KPI 1 & 2: leads */

/**
 * Every lead created in a window, from BOTH places this product keeps one.
 *
 * There are two, and they are genuinely different animals:
 *
 *   `customers.kind = 'lead'` — a party the book knows about that has never
 *     ordered. It has an owner, a source and a created date, and NO ladder.
 *   `mbos_leads` — somebody a salesman actually met, with the full ladder:
 *     new → contacted → qualified → negotiation → won/lost.
 *
 * Both are new business opportunities and both count, because the owner's
 * question is whether the company is generating any — not which table it
 * landed in. What differs is what can be said about them afterwards: only a
 * field lead can be `qualified`, which is why the conversion rate below is
 * measured over ALL leads and the qualified figure is reported beside it.
 *
 * DEDUPLICATED across the two. A field lead that was converted writes a
 * customer row, and if that row is itself a `kind = 'lead'` created in the same
 * window it would be the same opportunity counted twice — so a customer named
 * by any field lead's `converted_customer_id` is dropped from the CRM half.
 */
export async function leadsCreatedIn(
  range: DateRange,
  filters: OwnerFilters,
): Promise<LeadRow[]> {
  const w = windowOf(range);
  const where = await ownerFilterClause(filters);

  const [crm, field] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      with first_order as (
        select o.customer_id, min(o.ordered_at) as first_at
          from orders o
         where ${orderCountsSql("o")}
         group by o.customer_id
      )
      select c.id as lead_id,
             'crm' as origin,
             c.id as customer_id,
             c.lead_source as source,
             c.owner_id as owner_user_id,
             u.name as owner_name,
             c.region as state,
             c.city,
             c.customer_type,
             to_char(c.created_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as created_on,
             null::text as stage,
             to_char(f.first_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as first_order_on
        from customers c
        left join users u on u.id = c.owner_id
        left join first_order f on f.customer_id = c.id
       where c.kind = 'lead'
         and c.created_at >= ${w.start} and c.created_at <= ${w.end}
         and not exists (
           select 1 from mbos_leads ml where ml.converted_customer_id = c.id
         )
         and ${where}
    `),
    db.execute<Record<string, unknown>>(sql`
      with first_order as (
        select o.customer_id, min(o.ordered_at) as first_at
          from orders o
         where ${orderCountsSql("o")}
         group by o.customer_id
      )
      select l.id as lead_id,
             'field' as origin,
             l.converted_customer_id as customer_id,
             l.source::text as source,
             l.assigned_to_user_id as owner_user_id,
             u.name as owner_name,
             c.region as state,
             coalesce(l.city, c.city) as city,
             c.customer_type,
             to_char(l.server_created_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as created_on,
             l.stage::text as stage,
             to_char(f.first_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as first_order_on
        from mbos_leads l
        left join users u on u.id = l.assigned_to_user_id
        left join customers c on c.id = l.converted_customer_id
        left join first_order f on f.customer_id = l.converted_customer_id
       -- The SERVER's clock. A handset's is one its owner can set, and a lead
       -- backdated into last month would move a cohort somebody is judged on.
       where l.server_created_at >= ${w.start} and l.server_created_at <= ${w.end}
         -- An unconverted field lead has no customer row to filter on, so the
         -- customer filters can only narrow the ones that DO. Filtering them
         -- out entirely would drop every lead still being worked, which is
         -- most of them and exactly what the KPI is counting.
         and (c.id is null or ${where})
    `),
  ]);

  const map = (r: Record<string, unknown>): LeadRow => ({
    leadId: String(r.lead_id),
    origin: r.origin === "field" ? "field" : "crm",
    customerId: r.customer_id === null ? null : String(r.customer_id),
    source: r.source === null ? null : String(r.source),
    ownerUserId: r.owner_user_id === null ? null : String(r.owner_user_id),
    ownerName: r.owner_name === null ? null : String(r.owner_name),
    state: r.state === null ? null : String(r.state),
    city: r.city === null ? null : String(r.city),
    customerType: r.customer_type === null ? null : String(r.customer_type),
    createdOn: String(r.created_on),
    stage: r.stage === null ? null : String(r.stage),
    firstOrderOn: r.first_order_on === null ? null : String(r.first_order_on),
  });

  return [...crm.map(map), ...field.map(map)];
}

/* --------------------------------------------------- KPI 3 & 4: the sales */

export type SalesFigures = {
  grossValuePaise: number;
  creditNotePaise: number;
  transactions: number;
  /** Orders per customer who ordered at all in the window. */
  ordersPerCustomer: number[];
};

/**
 * What was sold in the window, and by how many separate transactions.
 *
 * A transaction is an ORDER that counts as a purchase — the same
 * `orderCountsSql` the buying cycle, the targets and the EOD value read, so
 * "did we sell anything" has one answer in this product rather than a
 * reporting one and an operational one.
 *
 * CREDIT NOTES ARE NETTED OFF. A credit note here is not a separate document:
 * `issueCreditNote` writes a confirmed receipt with `mode = 'Adjustment'` and
 * an idempotency key of `creditnote:<complaint>`, which is what makes it
 * datable at all. It reduces the VALUE and never the COUNT — a credit note is
 * not a sale that un-happened, it is money given back on one that did, and
 * removing the transaction would raise the average bill size every time
 * somebody allowed a claim.
 */
export async function salesFigures(
  range: DateRange,
  filters: OwnerFilters,
): Promise<SalesFigures> {
  const w = windowOf(range);
  const where = await ownerFilterClause(filters);

  const [totals, perCustomer, creditNotes] = await Promise.all([
    db.execute<{ value: string; n: number }>(sql`
      select coalesce(sum(o.total_amount), 0) as value, count(*)::int as n
        from orders o
        join customers c on c.id = o.customer_id
       where ${orderCountsSql("o")}
         and o.ordered_at >= ${w.start} and o.ordered_at <= ${w.end}
         and ${where}
    `),
    db.execute<{ n: number }>(sql`
      select count(*)::int as n
        from orders o
        join customers c on c.id = o.customer_id
       where ${orderCountsSql("o")}
         and o.ordered_at >= ${w.start} and o.ordered_at <= ${w.end}
         and ${where}
       group by o.customer_id
    `),
    db.execute<{ value: string }>(sql`
      select coalesce(sum(r.amount), 0) as value
        from payment_receipts r
        join customers c on c.id = r.customer_id
       where r.status = 'confirmed'
         and r.idempotency_key like 'creditnote:%'
         and r.received_at >= ${w.fromDate} and r.received_at <= ${w.toDate}
         and ${where}
    `),
  ]);

  return {
    grossValuePaise: Number(totals[0]?.value ?? 0),
    creditNotePaise: Number(creditNotes[0]?.value ?? 0),
    transactions: Number(totals[0]?.n ?? 0),
    ordersPerCustomer: perCustomer.map((r) => Number(r.n)),
  };
}

/* ------------------------------------------------------- KPI 5: retention */

export type BandedCustomer = {
  customerId: string;
  name: string;
  band: HealthBand;
  cycleDays: number;
  cycleIsMeasured: boolean;
  cyclesElapsed: number;
  daysOverdue: number;
  lastOrderDate: string | null;
  expectedOn: string | null;
  outstandingPaise: number;
  ownerName: string | null;
  lastCallOn: string | null;
  lastCallOutcome: string | null;
  nextCallOn: string | null;
};

/**
 * Every customer placed in a band, as of a day.
 *
 * Read live rather than from the snapshot table, because the snapshot is for
 * COMPARING two months and this is the present. A customer who ordered this
 * morning has moved band since last night, and a retention figure that told
 * the owner otherwise would be wrong in the direction that matters.
 *
 * A DEACTIVATED account is out entirely: somebody closed it deliberately, and
 * counting a closed account as lost would put a business decision into a
 * retention failure. A customer who has NEVER ordered gets no band at all —
 * they have not stopped buying, they have not started, and folding them into
 * `active` is exactly how a retention figure quietly flatters itself.
 */
export async function bandedCustomers(
  today: BusinessDate,
  filters: OwnerFilters,
): Promise<{ banded: BandedCustomer[]; neverOrdered: number; defaultCycle: number }> {
  const config = await getConfig();
  const where = await ownerFilterClause(filters);

  const rows = await db.execute<{
    id: string;
    name: string;
    cycle_days: number;
    cycle_confidence: number | null;
    last_order_date: string | null;
    outstanding: string;
    owner_name: string | null;
    last_call_on: string | null;
    last_call_outcome: string | null;
    next_call_on: string | null;
  }>(sql`
    select c.id, c.name, c.cycle_days, c.cycle_confidence,
           to_char(c.last_order_date, 'YYYY-MM-DD') as last_order_date,
           c.outstanding,
           coalesce(c.sales_person_name, u.name) as owner_name,
           to_char(k.started_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as last_call_on,
           k.outcome::text as last_call_outcome,
           to_char(k.next_step_date, 'YYYY-MM-DD') as next_call_on
      from customers c
      left join users u on u.id = ${creditedToSql("c")}
      -- The most recent call, for the drill-down: chasing an at-risk customer
      -- starts with knowing whether anybody has already rung them.
      left join lateral (
        select k2.started_at, k2.outcome, k2.next_step_date
          from calls k2
         where k2.customer_id = c.id
         order by k2.started_at desc
         limit 1
      ) k on true
     where c.status <> 'deactivated'
       and c.kind = 'customer'
       and not c.third_party
       and ${where}
  `);

  const banded: BandedCustomer[] = [];
  let neverOrdered = 0;
  let defaultCycle = 0;

  for (const r of rows) {
    const cycleDays = Number(r.cycle_days);
    const result = bandFor(
      { lastOrderDate: r.last_order_date as BusinessDate | null, cycleDays },
      today,
      config,
    );
    if (!result) {
      neverOrdered++;
      continue;
    }
    // A cycle nobody has measured is the configured default wearing a
    // customer's name. It still bands — the inactive flag has always worked
    // this way and two answers would be worse than one imprecise one — but the
    // screen is told how many, so the precision of the figure is visible.
    const measured = r.cycle_confidence !== null;
    if (!measured) defaultCycle++;

    banded.push({
      customerId: r.id,
      name: r.name,
      band: result.band,
      cycleDays,
      cycleIsMeasured: measured,
      cyclesElapsed: result.cyclesElapsed,
      daysOverdue: result.daysOverdue,
      lastOrderDate: r.last_order_date,
      expectedOn: r.last_order_date ? addDays(r.last_order_date, cycleDays) : null,
      outstandingPaise: Number(r.outstanding ?? 0),
      ownerName: r.owner_name,
      lastCallOn: r.last_call_on,
      lastCallOutcome: r.last_call_outcome,
      nextCallOn: r.next_call_on,
    });
  }

  return { banded, neverOrdered, defaultCycle };
}

/* -------------------------------------------------------------- movement */

/**
 * Who moved band between the end of one month and now.
 *
 * The earlier reading comes from `customer_health_snapshots`, which is the
 * only place it survives — a band is a statement about a day, and yesterday's
 * is unrecoverable once the customer has ordered. Where there is no snapshot
 * for the earlier month the answer is `null` rather than a movement of zero:
 * before the first night this ran there is nothing to compare against, and
 * "nobody moved" is a very different sentence to "we cannot say yet".
 */
export async function movementSince(
  earlierPeriod: string,
  today: BusinessDate,
  filters: OwnerFilters,
): Promise<{ movements: Movement[]; comparedWith: string } | null> {
  const rows = await db.execute<{ customer_id: string; band: string }>(sql`
    select s.customer_id, s.band
      from customer_health_snapshots s
      join customers c on c.id = s.customer_id
     where s.period = ${earlierPeriod}
       and ${await ownerFilterClause(filters)}
  `);
  if (!rows.length) return null;

  const before = new Map<string, HealthBand>(
    rows.map((r) => [r.customer_id, r.band as HealthBand]),
  );
  const { banded } = await bandedCustomers(today, filters);
  const after = new Map<string, HealthBand>(banded.map((b) => [b.customerId, b.band]));

  return { movements: movement(before, after), comparedWith: earlierPeriod };
}

/**
 * Write tonight's reading over this month's row.
 *
 * Idempotent, and that is what makes a closed month correct for free: the row
 * stops being overwritten on the last night of the month, so it holds the band
 * as it stood at month end without any job having to fire on the right day.
 * Nothing here touches a past month, and nothing may learn to.
 */
export async function snapshotCustomerHealth(
  today: BusinessDate,
): Promise<{ customers: number; period: string }> {
  const period = monthKey(today);
  // No filters: the snapshot is the whole book. Narrowing it would make the
  // history depend on who happened to run the job.
  const { banded } = await bandedCustomers(today, {});

  for (const c of banded) {
    await db.execute(sql`
      insert into customer_health_snapshots
        (id, customer_id, period, band, cycle_days, cycles_elapsed_bp,
         days_overdue, last_order_date, computed_at)
      values (${newId("chs")}, ${c.customerId}, ${period}, ${c.band},
              ${c.cycleDays}, ${Math.round(c.cyclesElapsed * 100)},
              ${c.daysOverdue}, ${c.lastOrderDate}, now())
      on conflict (customer_id, period) do update set
        band = excluded.band,
        cycle_days = excluded.cycle_days,
        cycles_elapsed_bp = excluded.cycles_elapsed_bp,
        days_overdue = excluded.days_overdue,
        last_order_date = excluded.last_order_date,
        computed_at = now()
    `);
  }

  return { customers: banded.length, period };
}

/* ------------------------------------------------------------ the five */

export type KpiCard<T> = {
  current: T;
  previous: T | null;
  lastYear: T | null;
  change: Change;
  changeVsLastYear: Change;
};

export type OwnerDashboard = {
  range: DateRange;
  comparedWith: DateRange;
  lastYearRange: DateRange;
  newLeads: KpiCard<number>;
  conversion: KpiCard<Conversion>;
  billSize: KpiCard<BillSize>;
  frequency: KpiCard<Frequency>;
  retention: Retention;
  previousRetention: Retention | null;
  alerts: OwnerAlert[];
  neverOrdered: number;
  defaultCycle: number;
};

/**
 * All five, for a window and the two windows it is read against.
 *
 * Three passes over the same shapes rather than one clever query: the periods
 * are different lengths and different calendars, and a single query that tried
 * to bucket them would need the comparison rule written into SQL, where it
 * could not be tested. `comparableRange` is pure and has tests; this just
 * calls it three times.
 */
export async function ownerDashboard(
  range: DateRange,
  comparedWith: DateRange,
  lastYearRange: DateRange,
  today: BusinessDate,
  filters: OwnerFilters,
): Promise<OwnerDashboard> {
  const config = await getConfig();

  const [
    leadsNow,
    leadsBefore,
    leadsLastYear,
    salesNow,
    salesBefore,
    salesLastYear,
    health,
  ] = await Promise.all([
    leadsCreatedIn(range, filters),
    leadsCreatedIn(comparedWith, filters),
    leadsCreatedIn(lastYearRange, filters),
    salesFigures(range, filters),
    salesFigures(comparedWith, filters),
    salesFigures(lastYearRange, filters),
    bandedCustomers(today, filters),
  ]);

  const conversionNow = conversionFor(leadsNow, today, config);
  const conversionBefore = conversionFor(leadsBefore, today, config);
  const conversionLastYear = conversionFor(leadsLastYear, today, config);

  const sizeNow = billSize(
    salesNow.grossValuePaise,
    salesNow.creditNotePaise,
    salesNow.transactions,
  );
  const sizeBefore = billSize(
    salesBefore.grossValuePaise,
    salesBefore.creditNotePaise,
    salesBefore.transactions,
  );
  const sizeLastYear = billSize(
    salesLastYear.grossValuePaise,
    salesLastYear.creditNotePaise,
    salesLastYear.transactions,
  );

  const freqNow = frequency(salesNow.transactions, salesNow.ordersPerCustomer, config);
  const freqBefore = frequency(
    salesBefore.transactions,
    salesBefore.ordersPerCustomer,
    config,
  );
  const freqLastYear = frequency(
    salesLastYear.transactions,
    salesLastYear.ordersPerCustomer,
    config,
  );

  const retentionNow = retention(health.banded.map((b) => b.band));
  const previousRetention = await retentionAt(
    monthKey(comparedWith.to),
    filters,
  );

  return {
    range,
    comparedWith,
    lastYearRange,
    newLeads: {
      current: leadsNow.length,
      previous: leadsBefore.length,
      lastYear: leadsLastYear.length,
      change: changeInCount(leadsNow.length, leadsBefore.length),
      changeVsLastYear: changeInCount(leadsNow.length, leadsLastYear.length),
    },
    conversion: {
      current: conversionNow,
      previous: conversionBefore,
      lastYear: conversionLastYear,
      change: changeInRate(
        conversionNow.ratePercent ?? 0,
        conversionBefore.ratePercent ?? 0,
      ),
      changeVsLastYear: changeInRate(
        conversionNow.ratePercent ?? 0,
        conversionLastYear.ratePercent ?? 0,
      ),
    },
    billSize: {
      current: sizeNow,
      previous: sizeBefore,
      lastYear: sizeLastYear,
      change: changeInCount(sizeNow.averagePaise ?? 0, sizeBefore.averagePaise ?? 0),
      changeVsLastYear: changeInCount(
        sizeNow.averagePaise ?? 0,
        sizeLastYear.averagePaise ?? 0,
      ),
    },
    frequency: {
      current: freqNow,
      previous: freqBefore,
      lastYear: freqLastYear,
      change: changeInCount(
        freqNow.perActiveCustomer ?? 0,
        freqBefore.perActiveCustomer ?? 0,
      ),
      changeVsLastYear: changeInCount(
        freqNow.perActiveCustomer ?? 0,
        freqLastYear.perActiveCustomer ?? 0,
      ),
    },
    retention: retentionNow,
    previousRetention,
    alerts: ownerAlerts(
      {
        conversion: conversionNow,
        previousConversion: conversionBefore,
        billSize: sizeNow,
        previousBillSize: sizeBefore,
        retention: retentionNow,
        previousRetention,
        newLeads: leadsNow.length,
        previousNewLeads: leadsBefore.length,
      },
      config,
    ),
    neverOrdered: health.neverOrdered,
    defaultCycle: health.defaultCycle,
  };
}

/** The band counts as they stood at the end of a month, from the snapshot. */
async function retentionAt(
  period: string,
  filters: OwnerFilters,
): Promise<Retention | null> {
  const rows = await db.execute<{ band: string }>(sql`
    select s.band
      from customer_health_snapshots s
      join customers c on c.id = s.customer_id
     where s.period = ${period}
       and ${await ownerFilterClause(filters)}
  `);
  if (!rows.length) return null;
  return retention(rows.map((r) => r.band as HealthBand));
}

/* ------------------------------------------------------------ breakdowns */

export type Breakdown = {
  key: string;
  label: string;
  leads: number;
  qualified: number;
  converted: number;
  ratePercent: number | null;
};

/**
 * Leads and what became of them, cut by one dimension.
 *
 * §6 and §11 both ask for the same table under different headings, so it is
 * one function taking the dimension rather than eight nearly-identical
 * queries. The cut happens in TypeScript over the cohort the KPI already
 * loaded — re-querying per dimension would run the same cohort eight times and
 * risk the breakdown disagreeing with the total above it.
 */
export function breakdownBy(
  cohort: LeadRow[],
  dimension: "owner" | "source" | "state" | "city" | "customerType" | "origin",
  today: BusinessDate,
  config: Parameters<typeof conversionFor>[2],
): Breakdown[] {
  const keyOf = (l: LeadRow): { key: string; label: string } => {
    switch (dimension) {
      case "owner":
        return { key: l.ownerUserId ?? "none", label: l.ownerName ?? "Nobody assigned" };
      case "source":
        return { key: l.source ?? "none", label: l.source ?? "No source recorded" };
      case "state":
        return { key: l.state ?? "none", label: l.state ?? "No region recorded" };
      case "city":
        return { key: l.city ?? "none", label: l.city ?? "No city recorded" };
      case "customerType":
        return {
          key: l.customerType ?? "none",
          label: l.customerType ?? "Not classified",
        };
      case "origin":
        return {
          key: l.origin,
          label: l.origin === "field" ? "Field (salesman)" : "CRM (telecaller)",
        };
    }
  };

  const groups = new Map<string, { label: string; rows: LeadRow[] }>();
  for (const lead of cohort) {
    const { key, label } = keyOf(lead);
    const group = groups.get(key) ?? { label, rows: [] };
    group.rows.push(lead);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const c = conversionFor(group.rows, today, config);
      return {
        key,
        label: group.label,
        leads: c.leads,
        qualified: c.qualified,
        converted: c.converted,
        ratePercent: c.ratePercent,
      };
    })
    .sort((a, b) => b.leads - a.leads);
}

/** The distinct values behind each filter, for the pickers. */
export async function filterOptions(): Promise<{
  regions: string[];
  cities: string[];
  salesmen: { id: string; name: string }[];
  salesManagers: { id: string; name: string }[];
  customerTypes: string[];
}> {
  const [regions, cities, people, types] = await Promise.all([
    db.execute<{ v: string }>(
      sql`select distinct region as v from customers where region is not null order by 1`,
    ),
    db.execute<{ v: string }>(
      sql`select distinct city as v from customers where city is not null order by 1 limit 300`,
    ),
    db.execute<{ id: string; name: string; is_manager: boolean }>(sql`
      select u.id, u.name,
             exists (select 1 from customers c2 where c2.sales_manager_id = u.id) as is_manager
        from users u
       where u.active
         and (exists (select 1 from customers c where ${creditedToSql("c")} = u.id)
              or exists (select 1 from customers c3 where c3.sales_manager_id = u.id))
       order by u.name
    `),
    db.execute<{ v: string }>(
      sql`select distinct customer_type::text as v from customers where customer_type is not null order by 1`,
    ),
  ]);

  return {
    regions: regions.map((r) => r.v),
    cities: cities.map((r) => r.v),
    salesmen: people.map((p) => ({ id: p.id, name: p.name })),
    salesManagers: people.filter((p) => p.is_manager).map((p) => ({ id: p.id, name: p.name })),
    customerTypes: types.map((r) => r.v),
  };
}

/**
 * Add days to a `YYYY-MM-DD` in that calendar and no zone at all.
 *
 * `new Date(iso)` then `toISOString()` is the shape §11's grep test refuses —
 * a date-only value has no instant to lose, but it is indistinguishable on
 * sight from truncating a stored one in UTC.
 */
function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(
    at.getUTCDate(),
  ).padStart(2, "0")}`;
}

/**
 * The launcher tile's sentence.
 *
 * Read from the SNAPSHOT rather than banded live: the launcher draws for
 * everybody on every visit to `/apps`, and a full scan of the book to fill one
 * line of text is not a thing to do on a page nobody is reading yet. It is at
 * most a night old, and the tile says nothing about freshness because a
 * headline count that moved overnight is not a figure anybody acts on directly.
 *
 * The badge stays at zero, like HRMS's headcount. An at-risk customer is real
 * work but it is not work done HERE — the chasing happens in the CRM, and a red
 * pill over a reporting app would read as a queue somebody has to clear.
 */
export async function healthTileLine(period: string): Promise<string> {
  const rows = await db.execute<{ band: string; n: number }>(sql`
    select band, count(*)::int as n
      from customer_health_snapshots
     where period = ${period}
     group by band
  `);
  if (!rows.length) return "No reading yet - the first runs tonight";

  const by = new Map(rows.map((r) => [r.band, Number(r.n)]));
  const parts: string[] = [];
  const active = by.get("active") ?? 0;
  const atRisk = by.get("at-risk") ?? 0;
  const dormant = by.get("dormant") ?? 0;
  if (active) parts.push(`${active} active`);
  if (atRisk) parts.push(`${atRisk} at risk`);
  if (dormant) parts.push(`${dormant} dormant`);
  return parts.length ? parts.join(" \u00b7 ") : "Nothing banded yet";
}
