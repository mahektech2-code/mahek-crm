import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  salesPerformance,
  salesPerformanceCategories,
} from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { APP_TIMEZONE, addDays, endOfMonth, isWorkingDay } from "@/lib/business-date";
import type { BusinessDate } from "@/lib/business-date";
import { matchKey } from "@/lib/catalogue";
import { billCreditDaysSql } from "@/lib/bill-terms";
import { creditedToSql } from "@/lib/sales-attribution";
import { orderCountsSql } from "@/lib/order-status";
import {
  alertsFor,
  forecast,
  ratingFor,
  scoreMix,
  weightedScore,
  type Alert,
  type ComponentInput,
  type Forecast,
  type MixBand,
  type MixActual,
  type MixResult,
  type ScoreResult,
} from "@/lib/engines/performance";

/* ---------------------------------------------------------------------------
 * The six answers, read off the ledger.
 *
 * `lib/engines/performance.ts` decides what a score MEANS; this file decides
 * what the numbers are. Everything here is a read of committed data — orders
 * that count as purchases, receipts accounts have confirmed, calls logged and
 * visits made — attributed to exactly one person by `lib/sales-attribution.ts`.
 *
 * The output lands in `sales_performance`, which is a CACHE like every other
 * derived value in this product: never hand-edited, rebuilt by
 * `recomputeSalesPerformance()`.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/** `YYYY-MM` to the first and last day of that month. */
function monthWindow(period: string): { from: string; to: string } {
  return { from: `${period}-01`, to: endOfMonth(period) };
}

/* ------------------------------------------------------- catalogue lookup */

type SkuFacts = {
  productId: string;
  millilitresPerCan: number | null;
  categoryId: string | null;
};

type Catalogue = {
  /** Every way a line might name a product, keyed by `matchKey`. */
  byName: Map<string, SkuFacts>;
  byId: Map<string, SkuFacts>;
  residualCategoryId: string | null;
  categories: { id: string; name: string; isResidual: boolean; displayOrder: number }[];
};

/**
 * The catalogue, small enough to hold.
 *
 * Two hundred SKUs and their aliases, resolved IN TYPESCRIPT rather than in
 * SQL — because the key an order line has to be matched on is `matchKey`, and
 * that function already exists. Rewriting "lowercase, strip everything that is
 * not a letter or a digit" as a `regexp_replace` would be a second copy of the
 * rule the catalogue import matches on, and the day the two disagree is the
 * day a product silently stops counting towards anybody's mix.
 */
export async function loadCatalogue(): Promise<Catalogue> {
  const [skus, aliases, categories] = await Promise.all([
    db.execute<{
      id: string;
      name: string;
      millilitres_per_can: number | null;
      category_id: string | null;
    }>(sql`
      select p.id, p.name, p.millilitres_per_can, f.category_id
        from products p
        left join product_formulations f on f.id = p.formulation_id
    `),
    db.execute<{ name: string; product_id: string }>(sql`
      select pa.name, pa.product_id from product_aliases pa
    `),
    db.execute<{
      id: string;
      name: string;
      is_residual: boolean;
      display_order: number;
    }>(sql`
      select id, name, is_residual, display_order
        from product_categories where active order by display_order
    `),
  ]);

  const byId = new Map<string, SkuFacts>();
  const byName = new Map<string, SkuFacts>();
  for (const row of skus) {
    const facts: SkuFacts = {
      productId: row.id,
      millilitresPerCan: row.millilitres_per_can,
      categoryId: row.category_id,
    };
    byId.set(row.id, facts);
    byName.set(matchKey(row.name), facts);
  }
  // Aliases are read on the way IN and never offered on a form — an old
  // spelling on a two-year-old order line still has to find its product.
  for (const a of aliases) {
    const facts = byId.get(a.product_id);
    if (facts) byName.set(matchKey(a.name), facts);
  }

  return {
    byName,
    byId,
    residualCategoryId: categories.find((c) => c.is_residual)?.id ?? null,
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      isResidual: c.is_residual,
      displayOrder: c.display_order,
    })),
  };
}

/* ------------------------------------------------------------- the actuals */

export type PersonActuals = {
  userId: string;
  revenuePaise: number;
  millilitres: number;
  /** Keyed by category id. */
  byCategory: Map<string, { valuePaise: number; millilitres: number }>;
  /** Line value whose product name resolved to nothing in the catalogue. */
  unmatchedPaise: number;
  newCustomers: number;
  /** Confirmed money collected against bills that were ALREADY overdue at the start of the month. */
  collectionPaise: number;
  /** What that money is a share of — the book's overdue balance at month start. */
  overdueAtStartPaise: number;
  activity: number;
};

type LineRow = {
  user_id: string | null;
  line_items: unknown;
  call_id: string | null;
  total_amount: number;
  order_id: string;
};

function emptyActuals(userId: string): PersonActuals {
  return {
    userId,
    revenuePaise: 0,
    millilitres: 0,
    byCategory: new Map(),
    unmatchedPaise: 0,
    newCustomers: 0,
    collectionPaise: 0,
    overdueAtStartPaise: 0,
    activity: 0,
  };
}

function addCategory(
  actuals: PersonActuals,
  categoryId: string,
  valuePaise: number,
  millilitres: number,
) {
  const current = actuals.byCategory.get(categoryId) ?? {
    valuePaise: 0,
    millilitres: 0,
  };
  current.valuePaise += valuePaise;
  current.millilitres += millilitres;
  actuals.byCategory.set(categoryId, current);
}

/**
 * Every figure the score is read from, for one month, for everybody.
 *
 * One pass over the company rather than one query per person: thirty people
 * times six components is a hundred and eighty round trips, and the manager
 * dashboard asks for all of them at once.
 */
export async function actualsForPeriod(
  period: string,
): Promise<Map<string, PersonActuals>> {
  const { from, to } = monthWindow(period);
  const catalogue = await loadCatalogue();
  const config = await getConfig();
  const people = new Map<string, PersonActuals>();
  const forUser = (id: string) => {
    const existing = people.get(id);
    if (existing) return existing;
    const fresh = emptyActuals(id);
    people.set(id, fresh);
    return fresh;
  };

  /*
   * A day window in SQL carries an explicit +05:30.
   *
   * Without it Postgres reads the bounds in the SESSION's zone, and the
   * session is not a property of the row — a 9am order on the 1st falls
   * outside "August" on a connection left in UTC. Local Postgres runs in
   * Asia/Kolkata and agrees with itself, so this is invisible here and wrong
   * in production, which is the trap this rule was written for.
   */
  const windowStart = sql.raw(`'${from} 00:00:00+05:30'::timestamptz`);
  const windowEnd = sql.raw(`'${to} 23:59:59.999+05:30'::timestamptz`);

  /* ---- revenue, volume and mix, from orders that count as purchases ---- */
  const orderRows = await db.execute<LineRow>(sql`
    select o.id as order_id,
           ${creditedToSql("c")} as user_id,
           o.line_items,
           o.call_id,
           o.total_amount
      from orders o
      join customers c on c.id = o.customer_id
     where ${orderCountsSql("o")}
       and o.ordered_at >= ${windowStart}
       and o.ordered_at <= ${windowEnd}
  `);

  // CRM orders carry no `line_items` — a telecaller's quantities live in
  // `interaction_product_lines`, in cans, against the call. They are worth
  // nothing (the product master holds no prices) but they are real litres, and
  // dropping them would understate the volume of anybody selling by phone.
  const callIds = orderRows
    .filter((r) => r.call_id && !Array.isArray(r.line_items))
    .map((r) => r.call_id as string);

  const crmLines = callIds.length
    ? await db.execute<{
        interaction_id: string;
        product_id: string;
        quantity: number;
      }>(sql`
        select ipl.interaction_id, ipl.product_id, ipl.quantity
          from interaction_product_lines ipl
         where ipl.interaction_id in ${sql`(${sql.join(
           callIds.map((i) => sql`${i}`),
           sql`, `,
         )})`}
      `)
    : [];

  const crmByCall = new Map<string, { product_id: string; quantity: number }[]>();
  for (const line of crmLines) {
    const list = crmByCall.get(line.interaction_id) ?? [];
    list.push(line);
    crmByCall.set(line.interaction_id, list);
  }

  for (const row of orderRows) {
    if (!row.user_id) continue; // unattributed — counted separately, never guessed at
    const actuals = forUser(row.user_id);

    // Revenue is the ORDER's total, not the sum of its lines. On a sheet order
    // they are equal by construction; where they are not, the order total is
    // what accounts and the customer both saw.
    actuals.revenuePaise += Number(row.total_amount ?? 0);

    const jsonLines = Array.isArray(row.line_items)
      ? (row.line_items as Record<string, unknown>[])
      : [];
    const fallback = jsonLines.length === 0 && row.call_id
      ? (crmByCall.get(row.call_id) ?? []).map((l) => ({
          productId: l.product_id,
          quantity: l.quantity,
          amount: 0,
        }))
      : [];

    const lines = jsonLines.length
      ? jsonLines.map((l) => ({
          productId: typeof l.productId === "string" ? l.productId : null,
          product: typeof l.product === "string" ? l.product : "",
          quantity: Number(l.quantity ?? 0),
          amount: Number(l.amount ?? 0),
        }))
      : fallback.map((l) => ({
          productId: l.productId,
          product: "",
          quantity: l.quantity,
          amount: 0,
        }));

    for (const line of lines) {
      // An MBOS line carries the product id outright; a sheet line carries only
      // the words somebody typed, so it is matched on the same key the
      // catalogue import matches on.
      const facts =
        (line.productId ? catalogue.byId.get(line.productId) : undefined) ??
        (line.product ? catalogue.byName.get(matchKey(line.product)) : undefined);

      const amount = Math.max(0, line.amount);

      if (!facts) {
        // Real money against a product nobody can identify. It counts as
        // revenue in full, contributes no litres, and falls to the residual
        // category — which is the honest place for it: excluding it would
        // shrink the denominator and inflate every share on the screen.
        actuals.unmatchedPaise += amount;
        if (catalogue.residualCategoryId) {
          addCategory(actuals, catalogue.residualCategoryId, amount, 0);
        }
        continue;
      }

      const ml = facts.millilitresPerCan
        ? Math.round(line.quantity * facts.millilitresPerCan)
        : 0;
      actuals.millilitres += ml;

      const categoryId = facts.categoryId ?? catalogue.residualCategoryId;
      if (categoryId) addCategory(actuals, categoryId, amount, ml);
    }
  }

  /* ---- new customers: the FIRST order that ever counted, landing here ---- */
  /*
   * A lead being created is not an acquisition. The brief is explicit and it
   * is also the only definition that cannot be gamed from a desk: a customer
   * is won when they place an order the business accepted, and the month it
   * counts in is the month of that first order.
   */
  const newCustomers = await db.execute<{ user_id: string | null; n: number }>(sql`
    with first_order as (
      select o.customer_id, min(o.ordered_at) as first_at
        from orders o
       where ${orderCountsSql("o")}
       group by o.customer_id
    )
    select ${creditedToSql("c")} as user_id, count(*)::int as n
      from first_order f
      join customers c on c.id = f.customer_id
     where f.first_at >= ${windowStart} and f.first_at <= ${windowEnd}
     group by 1
  `);
  for (const row of newCustomers) {
    if (!row.user_id) continue;
    forUser(row.user_id).newCustomers = Number(row.n);
  }

  /* ---- collection: share of what was ALREADY overdue at the start of the month, actually collected ---- */
  /*
   * Not "money collected" — money collected against a debt that predates the
   * month. A bill that goes overdue on the 15th and gets paid on the 20th is
   * ordinary business, not the collections target's business; this component
   * exists to measure whether OLD debt is being worked down.
   *
   * `overdue_bills` is a snapshot at the start of the window: the effective
   * due date (`billCreditDaysSql`, same fallback `effectiveDueDate` uses —
   * the bill's own date, then the order's credit term, then the customer's)
   * has to fall before the window opens, and the balance is reconstructed as
   * of that moment from confirmed allocations received before it — `bills.
   * paid_amount` is CURRENT and cannot answer "as of the 1st". `unstated`
   * bills are excluded, same as `outstandingTotals()`.
   *
   * `reported` and `held` receipts move no money anywhere else in this
   * product and they move none here either. A credit note is not money
   * collected either — see the comment this replaced.
   */
  const overdueRows = await db.execute<{
    user_id: string | null;
    overdue: string;
    collected: string;
  }>(sql`
    with overdue_bills as (
      select bills.id, bills.customer_id,
             bills.amount - coalesce((
               select sum(p.amount) from payments p
               join payment_receipts r on r.id = p.receipt_id
              where p.bill_id = bills.id
                and r.status = 'confirmed'
                and r.received_at < ${windowStart}
             ), 0) as balance_at_start
        from bills
       where bills.payment_position <> 'unstated'
         and coalesce(
               bills.due_date,
               bills.bill_date + (coalesce(${billCreditDaysSql}, ${config["bills.defaultCreditDays"]}) || ' days')::interval
             ) < ${windowStart}
    ),
    overdue as (
      select id, customer_id, balance_at_start
        from overdue_bills
       where balance_at_start > 0
    )
    select ${creditedToSql("c")} as user_id,
           sum(o.balance_at_start) as overdue,
           coalesce(sum(collected.amt), 0) as collected
      from overdue o
      join customers c on c.id = o.customer_id
      left join lateral (
        select sum(p.amount) as amt
          from payments p
          join payment_receipts r on r.id = p.receipt_id
         where p.bill_id = o.id
           and r.status = 'confirmed'
           and coalesce(r.idempotency_key, '') not like 'creditnote:%'
           and r.received_at >= ${windowStart}
           and r.received_at <= ${windowEnd}
      ) collected on true
     group by 1
  `);
  for (const row of overdueRows) {
    if (!row.user_id) continue;
    const actuals = forUser(row.user_id);
    actuals.overdueAtStartPaise = Number(row.overdue ?? 0);
    actuals.collectionPaise = Number(row.collected ?? 0);
  }

  /* ---- activity: tasks completed, not visits made ---- */
  /*
   * A task is an action item with somebody's name and a date on it —
   * assigned by a manager or raised by the system — and it is a different
   * thing to measure than a doorway visit or a logged call: this component
   * asks whether the things somebody was actually asked to do got done.
   *
   * Attributed to whoever the task was assigned TO, not whoever created it —
   * this is the one component that measures the act rather than the account.
   * Any task marked done in the window counts, whenever its due date was;
   * lateness is a different question to whether it happened at all.
   */
  const activity = await db.execute<{ user_id: string | null; n: number }>(sql`
    select assigned_to_user_id as user_id, count(*)::int as n
      from mbos_tasks
     where status = 'done'
       and completed_at >= ${windowStart}
       and completed_at <= ${windowEnd}
     group by 1
  `);
  for (const row of activity) {
    if (!row.user_id) continue;
    forUser(row.user_id).activity = Number(row.n);
  }

  return people;
}

/**
 * Orders in the period that belong to nobody.
 *
 * A customer with no salesman AND no back office person is not an error and is
 * not hidden — it is a row somebody has to go and fix, and it is the reason a
 * team's revenue can be less than the company's. The dashboard prints it.
 */
export async function unattributedForPeriod(period: string): Promise<{
  revenuePaise: number;
  customers: number;
}> {
  const { from, to } = monthWindow(period);
  const rows = await db.execute<{ total: string; customers: number }>(sql`
    select coalesce(sum(o.total_amount), 0) as total,
           count(distinct o.customer_id)::int as customers
      from orders o
      join customers c on c.id = o.customer_id
     where ${orderCountsSql("o")}
       and o.ordered_at >= ${sql.raw(`'${from} 00:00:00+05:30'::timestamptz`)}
       and o.ordered_at <= ${sql.raw(`'${to} 23:59:59.999+05:30'::timestamptz`)}
       and ${creditedToSql("c")} is null
  `);
  return {
    revenuePaise: Number(rows[0]?.total ?? 0),
    customers: Number(rows[0]?.customers ?? 0),
  };
}

/* ------------------------------------------------------------ working days */

/**
 * How much of the month has actually been worked, and how much of it there is.
 *
 * Working days rather than dates, because a forecast built on dates tells a
 * salesman on the 20th that he is further behind than he is. Holidays come
 * from `mbos_holidays`, which the office already maintains for the field team;
 * the working WEEK comes from configuration.
 */
export async function workingDaysIn(
  period: string,
  upTo: BusinessDate,
): Promise<{ elapsed: number; total: number }> {
  const config = await getConfig();
  const { from, to } = monthWindow(period);
  const holidays = await db.execute<{ on_date: string }>(sql`
    select to_char(on_date, 'YYYY-MM-DD') as on_date
      from mbos_holidays
     where on_date >= ${sql.raw(`'${from}'::date`)}
       and on_date <= ${sql.raw(`'${to}'::date`)}
  `);
  const off = new Set(holidays.map((h) => h.on_date));

  const week = {
    workingDays: config["workingDay.workingDays"],
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
  };
  let total = 0;
  let elapsed = 0;
  for (let d = from; d <= to; d = addDays(d as BusinessDate, 1)) {
    if (!isWorkingDay(d as BusinessDate, week) || off.has(d)) continue;
    total++;
    // Counting the current day as elapsed would divide by a day still being
    // worked and make everybody look behind every morning.
    if (d < upTo) elapsed++;
  }
  return { elapsed, total };
}


/* ------------------------------------------------------------ the reading */

export type PerformanceReading = {
  userId: string;
  userName: string;
  period: string;
  targetId: string | null;
  hasTarget: boolean;
  score: ScoreResult;
  mix: MixResult;
  rating: string;
  alerts: Alert[];
  revenueForecast: Forecast;
  volumeForecast: Forecast;
  actuals: PersonActuals;
  unmatchedPaise: number;
  workingDaysElapsed: number;
  workingDaysTotal: number;
};

type TargetRow = {
  id: string;
  user_id: string;
  user_name: string;
  revenue_target_paise: string | null;
  volume_target_ml: string | null;
  new_customer_target: number | null;
  collection_target_bp: number | null;
  activity_target: number | null;
};

const num = (v: string | number | null | undefined) =>
  v === null || v === undefined ? 0 : Number(v);

/**
 * Score everybody who either holds a published target or sold something.
 *
 * Both halves matter. Somebody with a target and no sales is the person a
 * manager most needs to see, and somebody selling with no target set is a
 * target somebody forgot to publish — showing neither is how a dashboard comes
 * to describe a smaller company than the one that exists.
 */
export async function readingsForPeriod(
  period: string,
  today: BusinessDate,
  options: { userIds?: string[]; includeDrafts?: boolean } = {},
): Promise<PerformanceReading[]> {
  const config = await getConfig();
  const [actuals, days, targets] = await Promise.all([
    actualsForPeriod(period),
    workingDaysIn(period, today),
    db.execute<TargetRow>(sql`
      select t.id, t.user_id, u.name as user_name,
             t.revenue_target_paise, t.volume_target_ml,
             t.new_customer_target, t.collection_target_bp, t.activity_target
        from sales_targets t
        join users u on u.id = t.user_id
       where t.period = ${period}
         ${options.includeDrafts ? sql`` : sql`and t.status = 'published'`}
    `),
  ]);

  const bands = await bandsForTargets(targets.map((t) => t.id));
  const targetByUser = new Map(targets.map((t) => [t.user_id, t]));

  const userIds = new Set<string>([
    ...targets.map((t) => t.user_id),
    ...actuals.keys(),
  ]);
  const wanted = options.userIds ? new Set(options.userIds) : null;

  const names = await namesFor([...userIds]);
  const readings: PerformanceReading[] = [];

  for (const userId of userIds) {
    if (wanted && !wanted.has(userId)) continue;
    const target = targetByUser.get(userId) ?? null;
    const a = actuals.get(userId) ?? emptyActuals(userId);
    const mixBands = target ? (bands.get(target.id) ?? []) : [];

    const mixActuals: MixActual[] = [...a.byCategory.entries()].map(
      ([categoryId, v]) => ({
        categoryId,
        valuePaise: v.valuePaise,
        millilitres: v.millilitres,
      }),
    );
    const mix = scoreMix(mixBands, mixActuals, config);

    const inputs: ComponentInput[] = [
      {
        key: "revenue",
        actual: a.revenuePaise,
        target: num(target?.revenue_target_paise),
      },
      { key: "volume", actual: a.millilitres, target: num(target?.volume_target_ml) },
      { key: "mix", actual: 0, target: 0, achievementBp: mix.achievementBp },
      {
        key: "newCustomers",
        actual: a.newCustomers,
        target: num(target?.new_customer_target),
      },
      {
        // The target is a PERCENTAGE of what was already overdue at the
        // start of the month, not a rupee figure — so it is converted to an
        // implied rupee target here, against this person's own overdue
        // book, and scored the same way every other rupee-vs-rupee
        // component is. Where nothing was overdue, the implied target is
        // zero, which `achievementBp` already treats as "not asked" and
        // drops from the score — a book with no old debt has nothing to be
        // measured on here, not a failing score.
        key: "collection",
        actual: a.collectionPaise,
        target: Math.round((a.overdueAtStartPaise * num(target?.collection_target_bp)) / 10_000),
      },
      { key: "activity", actual: a.activity, target: num(target?.activity_target) },
    ];

    const score = weightedScore(inputs, config);
    const by = (k: string) => score.components.find((c) => c.key === k);

    readings.push({
      userId,
      userName: names.get(userId) ?? target?.user_name ?? "Unknown",
      period,
      targetId: target?.id ?? null,
      hasTarget: target !== null,
      score,
      mix,
      rating: ratingFor(score.totalBp, config),
      alerts: alertsFor(
        {
          revenueBp: by("revenue")?.achievementBp ?? null,
          volumeBp: by("volume")?.achievementBp ?? null,
          collectionBp: by("collection")?.achievementBp ?? null,
          activityBp: by("activity")?.achievementBp ?? null,
          newCustomerActual: a.newCustomers,
          newCustomerTarget: num(target?.new_customer_target),
          mix,
          workingDaysElapsed: days.elapsed,
          workingDaysTotal: days.total,
        },
        config,
      ),
      revenueForecast: forecast({
        actual: a.revenuePaise,
        target: num(target?.revenue_target_paise),
        workingDaysElapsed: days.elapsed,
        workingDaysTotal: days.total,
      }),
      volumeForecast: forecast({
        actual: a.millilitres,
        target: num(target?.volume_target_ml),
        workingDaysElapsed: days.elapsed,
        workingDaysTotal: days.total,
      }),
      actuals: a,
      unmatchedPaise: a.unmatchedPaise,
      workingDaysElapsed: days.elapsed,
      workingDaysTotal: days.total,
    });
  }

  return readings.sort((x, y) => y.score.totalBp - x.score.totalBp);
}

async function bandsForTargets(
  targetIds: string[],
): Promise<Map<string, MixBand[]>> {
  if (!targetIds.length) return new Map();
  const rows = await db.execute<{
    target_id: string;
    category_id: string;
    name: string;
    minimum_bp: number;
    target_bp: number;
    stretch_bp: number;
    display_order: number;
  }>(sql`
    select tc.target_id, tc.category_id, pc.name,
           tc.minimum_bp, tc.target_bp, tc.stretch_bp, pc.display_order
      from sales_target_categories tc
      join product_categories pc on pc.id = tc.category_id
     where tc.target_id in ${sql`(${sql.join(
       targetIds.map((i) => sql`${i}`),
       sql`, `,
     )})`}
     order by pc.display_order
  `);
  const out = new Map<string, MixBand[]>();
  for (const r of rows) {
    const list = out.get(r.target_id) ?? [];
    list.push({
      categoryId: r.category_id,
      name: r.name,
      minimumBp: r.minimum_bp,
      targetBp: r.target_bp,
      stretchBp: r.stretch_bp,
    });
    out.set(r.target_id, list);
  }
  return out;
}

async function namesFor(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db.execute<{ id: string; name: string }>(sql`
    select id, name from users where id in ${sql`(${sql.join(
      ids.map((i) => sql`${i}`),
      sql`, `,
    )})`}
  `);
  return new Map(rows.map((r) => [r.id, r.name]));
}

/* ----------------------------------------------------------- the rebuild */

/**
 * Write the readings to the cache.
 *
 * Idempotent and re-runnable, like every other recompute here: it rewrites
 * every row for the period rather than adjusting one, which is what makes a
 * corrected order, a confirmed receipt and a revised target all land on the
 * same answer.
 */
export async function recomputeSalesPerformance(
  period: string,
  today: BusinessDate,
): Promise<{ people: number }> {
  const readings = await readingsForPeriod(period, today);

  for (const reading of readings) {
    const by = (k: string) => reading.score.components.find((c) => c.key === k);
    const rowId = newId("sperf");

    const inserted = await db.execute<{ id: string }>(sql`
      insert into sales_performance (
        id, user_id, period, target_id,
        revenue_target_paise, revenue_actual_paise, revenue_achievement_bp,
        volume_target_ml, volume_actual_ml, volume_achievement_bp,
        mix_achievement_bp,
        new_customer_target, new_customer_actual, new_customer_achievement_bp,
        collection_target_paise, collection_actual_paise, collection_achievement_bp,
        activity_target, activity_actual, activity_achievement_bp,
        total_score_bp, rating, untargeted, unmatched_revenue_paise, computed_at
      ) values (
        ${rowId}, ${reading.userId}, ${period}, ${reading.targetId},
        ${by("revenue")?.target ?? null}, ${reading.actuals.revenuePaise}, ${by("revenue")?.achievementBp ?? null},
        ${by("volume")?.target ?? null}, ${reading.actuals.millilitres}, ${by("volume")?.achievementBp ?? null},
        ${reading.mix.achievementBp},
        ${by("newCustomers")?.target ?? null}, ${reading.actuals.newCustomers}, ${by("newCustomers")?.achievementBp ?? null},
        ${by("collection")?.target ?? null}, ${reading.actuals.collectionPaise}, ${by("collection")?.achievementBp ?? null},
        ${by("activity")?.target ?? null}, ${reading.actuals.activity}, ${by("activity")?.achievementBp ?? null},
        ${reading.score.totalBp}, ${reading.rating},
        ${JSON.stringify(reading.score.untargeted)}::jsonb,
        ${reading.unmatchedPaise}, now()
      )
      on conflict (user_id, period) do update set
        target_id = excluded.target_id,
        revenue_target_paise = excluded.revenue_target_paise,
        revenue_actual_paise = excluded.revenue_actual_paise,
        revenue_achievement_bp = excluded.revenue_achievement_bp,
        volume_target_ml = excluded.volume_target_ml,
        volume_actual_ml = excluded.volume_actual_ml,
        volume_achievement_bp = excluded.volume_achievement_bp,
        mix_achievement_bp = excluded.mix_achievement_bp,
        new_customer_target = excluded.new_customer_target,
        new_customer_actual = excluded.new_customer_actual,
        new_customer_achievement_bp = excluded.new_customer_achievement_bp,
        collection_target_paise = excluded.collection_target_paise,
        collection_actual_paise = excluded.collection_actual_paise,
        collection_achievement_bp = excluded.collection_achievement_bp,
        activity_target = excluded.activity_target,
        activity_actual = excluded.activity_actual,
        activity_achievement_bp = excluded.activity_achievement_bp,
        total_score_bp = excluded.total_score_bp,
        rating = excluded.rating,
        untargeted = excluded.untargeted,
        unmatched_revenue_paise = excluded.unmatched_revenue_paise,
        computed_at = now()
      returning id
    `);

    const performanceId = inserted[0]?.id ?? rowId;

    // The per-category half is replaced wholesale rather than upserted: a
    // category taken off a target has to disappear, and a per-row upsert would
    // leave last month's band sitting under a share nobody is measuring.
    await db.execute(
      sql`delete from sales_performance_categories where performance_id = ${performanceId}`,
    );
    for (const cat of reading.mix.categories) {
      await db.insert(salesPerformanceCategories).values({
        id: newId("sperfc"),
        performanceId,
        categoryId: cat.categoryId,
        targetBp: cat.targetBp,
        minimumBp: cat.minimumBp,
        stretchBp: cat.stretchBp,
        actualPaise: cat.valuePaise,
        actualMl: cat.millilitres,
        actualBp: cat.actualBp,
        status: cat.status,
        scoreBp: cat.scoreBp,
      });
    }
  }

  return { people: readings.length };
}

export { salesPerformance, APP_TIMEZONE };
