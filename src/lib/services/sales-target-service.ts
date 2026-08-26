import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { addMonths } from "@/lib/business-date";
import { creditedToSql } from "@/lib/sales-attribution";
import { orderCountsSql } from "@/lib/order-status";

/* ---------------------------------------------------------------------------
 * Reads behind the target-setting screen.
 *
 * The screen's job is not to collect five numbers — anybody can type five
 * numbers. It is to put the numbers somebody is about to ASK FOR beside what
 * that person has actually done, because a target set with no history in front
 * of it is a guess, and a guess is what makes a whole team's targets either
 * unreachable or free.
 * ------------------------------------------------------------------------- */

export type TargetRow = {
  userId: string;
  userName: string;
  targetId: string | null;
  status: "draft" | "published" | null;
  revenueTargetPaise: number | null;
  volumeTargetMl: number | null;
  newCustomerTarget: number | null;
  collectionTargetPaise: number | null;
  activityTarget: number | null;
  publishedAt: Date | null;
  bands: {
    categoryId: string;
    name: string;
    minimumBp: number;
    targetBp: number;
    stretchBp: number;
  }[];
  /** How many months of this target have been revised since publishing. */
  revisions: number;
  /**
   * True where this row was written by `copyForwardSalesTargets` and nobody
   * has touched it since — last month's commitment, continuing rather than
   * chosen for this month. A real save, of even one figure, clears it.
   */
  carriedForward: boolean;
};

/**
 * Everybody who could carry a target, and what they are carrying.
 *
 * "Could carry" used to mean anybody an account is credited to — every field
 * salesman with a book AND every back office person working accounts that
 * have no salesman. That fall-through reads `sales_am_id` and
 * `back_office_am_id`, which an account manager or an accounts clerk can end
 * up holding too, and a target screen with the whole company on it is not one
 * a manager can read at a glance. The default list is now SALES ROLES only —
 * `users.role = 'telecaller'`, which is what every telecaller and every field
 * salesman is seeded as, manager/accounts/admin being separate roles — and
 * still credited, so an account with no salesman still finds its back office
 * carrier. Anybody who already HAS a target for the period is kept regardless
 * of role: a target already given to somebody is a decision, and a role
 * filter must not make it disappear from under them.
 */
export async function targetableCandidates(period: string): Promise<TargetRow[]> {
  const rows = await db.execute<{
    user_id: string;
    user_name: string;
    target_id: string | null;
    status: "draft" | "published" | null;
    revenue_target_paise: string | null;
    volume_target_ml: string | null;
    new_customer_target: number | null;
    collection_target_paise: string | null;
    activity_target: number | null;
    published_at: Date | null;
    revisions: number;
    carried_forward: boolean | null;
  }>(sql`
    with credited as (
      select distinct ${creditedToSql("c")} as user_id
        from customers c
       where c.status = 'active'
    )
    select u.id as user_id, u.name as user_name,
           t.id as target_id, t.status,
           t.revenue_target_paise, t.volume_target_ml, t.new_customer_target,
           t.collection_target_paise, t.activity_target, t.published_at,
           t.carried_forward,
           (select count(*)::int from sales_target_revisions r
             where r.target_id = t.id) as revisions
      from users u
      left join sales_targets t on t.user_id = u.id and t.period = ${period}
     where u.active
       and (
         (u.role = 'telecaller'
          and u.id in (select user_id from credited where user_id is not null))
         or t.id is not null
       )
     order by u.name
  `);

  const bands = await bandsByTarget(
    rows.map((r) => r.target_id).filter((x): x is string => Boolean(x)),
  );

  return rows.map((r) => ({
    userId: r.user_id,
    userName: r.user_name,
    targetId: r.target_id,
    status: r.status,
    revenueTargetPaise: r.revenue_target_paise === null ? null : Number(r.revenue_target_paise),
    volumeTargetMl: r.volume_target_ml === null ? null : Number(r.volume_target_ml),
    newCustomerTarget: r.new_customer_target,
    collectionTargetPaise:
      r.collection_target_paise === null ? null : Number(r.collection_target_paise),
    activityTarget: r.activity_target,
    publishedAt: r.published_at,
    bands: r.target_id ? (bands.get(r.target_id) ?? []) : [],
    revisions: Number(r.revisions ?? 0),
    carriedForward: Boolean(r.carried_forward),
  }));
}

async function bandsByTarget(ids: string[]) {
  const out = new Map<string, TargetRow["bands"]>();
  if (!ids.length) return out;
  const rows = await db.execute<{
    target_id: string;
    category_id: string;
    name: string;
    minimum_bp: number;
    target_bp: number;
    stretch_bp: number;
  }>(sql`
    select tc.target_id, tc.category_id, pc.name,
           tc.minimum_bp, tc.target_bp, tc.stretch_bp
      from sales_target_categories tc
      join product_categories pc on pc.id = tc.category_id
     where tc.target_id in ${sql`(${sql.join(
       ids.map((i) => sql`${i}`),
       sql`, `,
     )})`}
     order by pc.display_order
  `);
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

/* --------------------------------------------------------- the history */

export type Baseline = {
  /** Averages over the trailing months, per month. */
  revenuePaise: number;
  millilitres: number;
  newCustomers: number;
  collectionPaise: number;
  monthsCounted: number;
  /** The same months a year earlier, where there are any. */
  lastYearRevenuePaise: number | null;
};

/**
 * What this person has actually been doing, per month.
 *
 * §21 of the brief: the target-setting decision stays with management, and the
 * system's job is to put the trailing average in front of them so the growth
 * they are asking for is a number they chose rather than one they discovered
 * in March. The screen shows the implied growth beside the figure being typed.
 *
 * It reads ORDERS rather than `sales_performance`, deliberately: the cache
 * only holds months somebody has been scored in, and the first target ever set
 * is set before anybody has been scored at all.
 */
export async function baselineFor(
  userId: string,
  period: string,
  months: number,
): Promise<Baseline> {
  const from = `${addMonths(period, -months)}-01`;
  const to = `${period}-01`;
  const lastYearFrom = `${addMonths(period, -12 - months)}-01`;
  const lastYearTo = `${addMonths(period, -12)}-01`;

  const window = (a: string, b: string) => ({
    start: sql.raw(`'${a} 00:00:00+05:30'::timestamptz`),
    end: sql.raw(`'${b} 00:00:00+05:30'::timestamptz`),
  });
  const w = window(from, to);
  const ly = window(lastYearFrom, lastYearTo);

  const [sales, lastYear, collected, won] = await Promise.all([
    db.execute<{ total: string; n: number }>(sql`
      select coalesce(sum(o.total_amount), 0) as total,
             count(distinct to_char(o.ordered_at at time zone 'Asia/Kolkata', 'YYYY-MM'))::int as n
        from orders o
        join customers c on c.id = o.customer_id
       where ${orderCountsSql("o")}
         and ${creditedToSql("c")} = ${userId}
         and o.ordered_at >= ${w.start} and o.ordered_at < ${w.end}
    `),
    db.execute<{ total: string }>(sql`
      select coalesce(sum(o.total_amount), 0) as total
        from orders o
        join customers c on c.id = o.customer_id
       where ${orderCountsSql("o")}
         and ${creditedToSql("c")} = ${userId}
         and o.ordered_at >= ${ly.start} and o.ordered_at < ${ly.end}
    `),
    db.execute<{ total: string }>(sql`
      select coalesce(sum(r.amount), 0) as total
        from payment_receipts r
        join customers c on c.id = r.customer_id
       where r.status = 'confirmed'
         and ${creditedToSql("c")} = ${userId}
         and r.received_at >= ${sql.raw(`'${from}'::date`)}
         and r.received_at < ${sql.raw(`'${to}'::date`)}
    `),
    db.execute<{ n: number }>(sql`
      with first_order as (
        select o.customer_id, min(o.ordered_at) as first_at
          from orders o
         where ${orderCountsSql("o")}
         group by o.customer_id
      )
      select count(*)::int as n
        from first_order f
        join customers c on c.id = f.customer_id
       where ${creditedToSql("c")} = ${userId}
         and f.first_at >= ${w.start} and f.first_at < ${w.end}
    `),
  ]);

  /*
   * Divide by the months that HAPPENED, not by the months asked for.
   *
   * Somebody who joined two months ago has two months of history, and dividing
   * their total by six would show a third of what they sell — then a target
   * built on it would be a third of what they can do, on their first month.
   * Falling back to the window only where there is nothing at all.
   */
  const monthsCounted = Math.max(1, Number(sales[0]?.n ?? 0));
  const lastYearTotal = Number(lastYear[0]?.total ?? 0);

  // Litres are read from the cache, which is the only place they are resolved
  // — the name-to-SKU matching lives in the performance service and is not
  // worth doing twice.
  const volume = await db.execute<{ total: string; n: number }>(sql`
    select coalesce(sum(volume_actual_ml), 0) as total, count(*)::int as n
      from sales_performance
     where user_id = ${userId}
       and period >= ${addMonths(period, -months)}
       and period < ${period}
  `);
  const volumeMonths = Math.max(1, Number(volume[0]?.n ?? 0));

  return {
    revenuePaise: Math.round(Number(sales[0]?.total ?? 0) / monthsCounted),
    millilitres: Math.round(Number(volume[0]?.total ?? 0) / volumeMonths),
    newCustomers: Math.round(Number(won[0]?.n ?? 0) / monthsCounted),
    collectionPaise: Math.round(Number(collected[0]?.total ?? 0) / monthsCounted),
    monthsCounted,
    lastYearRevenuePaise: lastYearTotal > 0 ? Math.round(lastYearTotal / months) : null,
  };
}

/** The mix categories a target can be set on. */
export async function mixCategories(): Promise<
  { id: string; name: string; isResidual: boolean }[]
> {
  const rows = await db.execute<{ id: string; name: string; is_residual: boolean }>(sql`
    select id, name, is_residual from product_categories
     where active order by display_order
  `);
  return rows.map((r) => ({ id: r.id, name: r.name, isResidual: r.is_residual }));
}

/** Every change made to a published target, newest first. */
export async function revisionsFor(targetId: string) {
  return db.execute<{
    field: string;
    old_value: string | null;
    new_value: string | null;
    reason: string;
    reason_note: string | null;
    changed_by_name: string | null;
    changed_at: Date;
  }>(sql`
    select field, old_value, new_value, reason, reason_note,
           changed_by_name, changed_at
      from sales_target_revisions
     where target_id = ${targetId}
     order by changed_at desc
     limit 100
  `);
}
