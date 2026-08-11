import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE, dayBoundaryWindow } from "../business-date";
import { billCreditDaysSql } from "../bill-terms";
import { getConfig } from "../config/store";
import type { Config } from "../config/registry";
import { agingBucket } from "../engines/escalation";
import { today } from "../recompute";

/* ---------------------------------------------------------------------------
 * The Accounts landing screen.
 *
 * One question: what is waiting on this desk, and what has already been
 * decided today. Every figure here is read from the same place its own screen
 * reads it, so the card and the queue behind it can never disagree.
 *
 * Confirmed money only, everywhere. A reported receipt appears in exactly one
 * figure — "awaiting confirmation" — and is kept out of the rest, because a
 * claim folded into a collections total is a claim nobody can unpick later.
 * ------------------------------------------------------------------------- */

export type QueueSummary = {
  /** How many rows are waiting. */
  count: number;
  /** Paise held by those rows. */
  value: number;
  /** Hours the longest-waiting row has been there; 0 when nothing waits. */
  oldestHours: number;
  /** How many are past the staleness threshold. */
  stale: number;
};

export type AgingBucket = {
  label: string;
  amount: number;
  /** Lower bound in days overdue, for ordering and colour. */
  from: number;
};

export type DecidedToday = {
  action: string;
  actorName: string | null;
  /** The sentence a person reads: "Confirmed ₹96,800 received". */
  line: string;
  customerName: string | null;
  at: Date;
};

export type AccountsHome = {
  orders: QueueSummary;
  payments: QueueSummary;
  credits: QueueSummary;
  money: {
    confirmedToday: number;
    confirmedTodayCount: number;
    confirmedThisMonth: number;
    confirmedThisMonthCount: number;
    awaiting: number;
    awaitingCount: number;
    onAccount: number;
  };
  aging: { total: number; bills: number; buckets: AgingBucket[] };
  decided: DecidedToday[];
  /** Configuration, so every sentence on the screen interpolates the real value. */
  staleHours: number;
  quietDays: number;
};

/**
 * The audit actions this desk is responsible for. Read from the audit log
 * rather than from each table, because "what did I decide today" is a question
 * about decisions, and the log is the only place that records the decision
 * rather than its result.
 */
const DECISION_ACTIONS = [
  "order.approve",
  "order.decline",
  "payment.confirm",
  "payment.reject",
  "payment.record",
  "creditnote.issue",
  "creditnote.refuse",
  "payment.apply_on_account",
] as const;

export async function accountsHome(): Promise<AccountsHome> {
  const config = await getConfig();
  const day = await today();
  const staleHours = config["payments.confirmationAgeWarningHours"];
  const bucketBounds = config["bills.agingBuckets"];

  const [row] = await db.execute<{
    orders_count: number;
    orders_value: number;
    orders_oldest: number;
    orders_stale: number;
    pay_count: number;
    pay_value: number;
    pay_oldest: number;
    pay_stale: number;
    cn_count: number;
    cn_value: number;
    cn_oldest: number;
    today_amount: number;
    today_count: number;
    month_amount: number;
    month_count: number;
    on_account: number;
  }>(sql`
    select
      (select count(*)::int from orders where status = 'pending_approval') as orders_count,
      (select coalesce(sum(total_amount), 0)::bigint from orders
        where status = 'pending_approval') as orders_value,
      (select coalesce(max(extract(epoch from (now() - ordered_at)) / 3600), 0)::int
         from orders where status = 'pending_approval') as orders_oldest,
      (select count(*)::int from orders
        where status = 'pending_approval'
          and extract(epoch from (now() - ordered_at)) / 3600 > ${staleHours}) as orders_stale,

      (select count(*)::int from payment_receipts where status = 'reported') as pay_count,
      (select coalesce(sum(amount), 0)::bigint from payment_receipts
        where status = 'reported') as pay_value,
      (select coalesce(max(extract(epoch from (now() - created_at)) / 3600), 0)::int
         from payment_receipts where status = 'reported') as pay_oldest,
      (select count(*)::int from payment_receipts
        where status = 'reported'
          and extract(epoch from (now() - created_at)) / 3600 > ${staleHours}) as pay_stale,

      (select count(*)::int from complaints
        where request_cn = true
          and coalesce(cn_status, 'requested') in ('requested', 'under_review')) as cn_count,
      (select coalesce(sum(cn_amount), 0)::bigint from complaints
        where request_cn = true
          and coalesce(cn_status, 'requested') in ('requested', 'under_review')) as cn_value,
      (select coalesce(max(extract(epoch from (now() - created_at)) / 3600), 0)::int
         from complaints
        where request_cn = true
          and coalesce(cn_status, 'requested') in ('requested', 'under_review')) as cn_oldest,

      -- Confirmed money only. The date is the day the money is SAID to have
      -- arrived, not the day somebody typed it, because that is the date on
      -- the bank statement it will be reconciled against.
      -- The Adjustment mode is excluded on purpose. A credit note is recorded
      -- as a receipt so it settles bills through the same rebuild as any other
      -- money, but no cash arrived, and a figure headed "money in" that counts
      -- paperwork is a figure somebody will reconcile against the bank and
      -- find short.
      (select coalesce(sum(amount), 0)::bigint from payment_receipts
        where status = 'confirmed' and mode <> 'Adjustment'
          and received_at = ${day}::date) as today_amount,
      (select count(*)::int from payment_receipts
        where status = 'confirmed' and mode <> 'Adjustment'
          and received_at = ${day}::date) as today_count,
      (select coalesce(sum(amount), 0)::bigint from payment_receipts
        where status = 'confirmed' and mode <> 'Adjustment'
          and received_at >= date_trunc('month', ${day}::date)
          and received_at <= ${day}::date) as month_amount,
      (select count(*)::int from payment_receipts
        where status = 'confirmed' and mode <> 'Adjustment'
          and received_at >= date_trunc('month', ${day}::date)
          and received_at <= ${day}::date) as month_count,

      -- Money received and never pointed at a bill.
      (select coalesce(sum(p.amount), 0)::bigint
         from payments p
         join payment_receipts r on r.id = p.receipt_id
        where p.bill_id is null and r.status = 'confirmed') as on_account
  `);

  const aging = await agingAcrossTheBook(bucketBounds, config["bills.defaultCreditDays"]);
  // The working day is Asia/Kolkata and it does not start at midnight, so the
  // window is asked for rather than derived from a calendar date. A decision
  // taken at 2am belongs to the shift that started yesterday.
  const decided = await decidedToday(
    dayBoundaryWindow(day, {
      timezone: config["workingDay.timezone"],
      dayBoundaryHour: config["workingDay.dayBoundaryHour"],
      workingDays: config["workingDay.workingDays"],
    }),
  );

  const n = (v: unknown) => Number(v ?? 0);

  return {
    orders: {
      count: n(row?.orders_count),
      value: n(row?.orders_value),
      oldestHours: n(row?.orders_oldest),
      stale: n(row?.orders_stale),
    },
    payments: {
      count: n(row?.pay_count),
      value: n(row?.pay_value),
      oldestHours: n(row?.pay_oldest),
      stale: n(row?.pay_stale),
    },
    credits: {
      count: n(row?.cn_count),
      value: n(row?.cn_value),
      oldestHours: n(row?.cn_oldest),
      stale: 0,
    },
    money: {
      confirmedToday: n(row?.today_amount),
      confirmedTodayCount: n(row?.today_count),
      confirmedThisMonth: n(row?.month_amount),
      confirmedThisMonthCount: n(row?.month_count),
      awaiting: n(row?.pay_value),
      awaitingCount: n(row?.pay_count),
      onAccount: n(row?.on_account),
    },
    aging,
    decided,
    staleHours,
    quietDays: config["payments.reportedQuietDays"],
  };
}

/**
 * Every open bill in the book, bucketed by how far past its due date it is.
 *
 * The due date is resolved the way the rest of the application resolves it —
 * the bill's own, then the order's term, then the customer's, then the
 * configured default — so this strip and the collections screens agree about
 * which bills are late. `billCreditDaysSql` is that resolution, shared rather
 * than restated here.
 */
export async function agingAcrossTheBook(
  bounds: number[],
  defaultCreditDays: number,
): Promise<{ total: number; bills: number; buckets: AgingBucket[] }> {
  const rows = await db.execute<{ overdue_days: number; balance: number }>(sql`
    select
      greatest(
        0,
        (now() at time zone ${APP_TIMEZONE})::date - coalesce(
          bills.due_date,
          bills.bill_date
            + (coalesce(${billCreditDaysSql}, ${defaultCreditDays}) || ' days')::interval
        )::date
      )::int as overdue_days,
      (bills.amount - bills.paid_amount)::bigint as balance
    from bills
    where bills.amount > bills.paid_amount
      -- Aging is a statement about debt: this bucket is money that is ninety
      -- days late. A bill nobody has stated a position for is not late, it is
      -- unknown, and putting it in a bucket makes it look decided.
      and bills.payment_position = 'stated'
  `);

  return bucketise(
    rows.map((r) => ({ overdueDays: Number(r.overdue_days), balance: Number(r.balance) })),
    bounds,
  );
}

/**
 * The aging strip.
 *
 * The band a bill falls in is `agingBucket` from the escalation engine and
 * nothing else — the Bills table labels each row with that same function, so a
 * second set of bands here would put the strip and the rows it sits above into
 * quiet disagreement. This only decides the ORDER they are drawn in, which the
 * engine has no opinion about because it labels one bill at a time.
 */
export function bucketise(
  rows: Array<{ overdueDays: number; balance: number }>,
  bounds: number[],
): { total: number; bills: number; buckets: AgingBucket[] } {
  const config = { "bills.agingBuckets": bounds } as Pick<Config, "bills.agingBuckets">;
  const edges = [...bounds].sort((a, b) => a - b);

  // "Not due" first, then one band per boundary, oldest debt last.
  const order: Array<{ from: number; label: string }> = [
    { from: -1, label: agingBucket(0, config) },
    ...edges.map((from) => ({ from, label: agingBucket(from + 1, config) })),
  ];

  const buckets: AgingBucket[] = [];
  const at = new Map<string, number>();
  for (const band of order) {
    if (at.has(band.label)) continue;
    at.set(band.label, buckets.length);
    buckets.push({ from: band.from, label: band.label, amount: 0 });
  }

  let total = 0;
  for (const r of rows) {
    total += r.balance;
    const label = agingBucket(r.overdueDays, config);
    const index = at.get(label);
    // A band the ordering did not predict is still shown rather than dropped:
    // money that vanishes off a strip is worse than a band in the wrong place.
    if (index === undefined) {
      at.set(label, buckets.length);
      buckets.push({ from: Number.MAX_SAFE_INTEGER, label, amount: r.balance });
    } else {
      buckets[index].amount += r.balance;
    }
  }

  return { total, bills: rows.length, buckets };
}

/**
 * What this desk decided today, newest first. The audit log is the source —
 * a decision reversed later still happened, and the log is the only record
 * that says so.
 */
async function decidedToday(window: {
  start: string;
  end: string;
}): Promise<DecidedToday[]> {
  const rows = await db.execute<{
    action: string;
    actor: string | null;
    entity_type: string;
    entity_id: string | null;
    after: Record<string, unknown> | null;
    customer_name: string | null;
    at: Date;
  }>(sql`
    select a.action, u.name as actor, a.entity_type, a.entity_id,
           a.after_state as after, a.at,
           coalesce(oc.name, rc.name, cc.name) as customer_name
      from audit_log a
      left join users u on u.id = a.actor_id
      left join orders o on a.entity_type = 'order' and o.id = a.entity_id
      left join customers oc on oc.id = o.customer_id
      left join payment_receipts r on a.entity_type = 'payment_receipt' and r.id = a.entity_id
      left join customers rc on rc.id = r.customer_id
      left join complaints cm on a.entity_type = 'complaint' and cm.id = a.entity_id
      left join customers cc on cc.id = cm.customer_id
     where a.action in ${sql.raw(`(${DECISION_ACTIONS.map((x) => `'${x}'`).join(",")})`)}
       and a.at >= ${window.start}::timestamptz
       and a.at <  ${window.end}::timestamptz
     order by a.at desc
     limit 20
  `);

  return rows.map((r) => ({
    action: r.action,
    actorName: r.actor,
    customerName: r.customer_name,
    at: new Date(r.at),
    line: decisionLine(r.action, r.after),
  }));
}

/** A stored action is not a sentence. This is the one place that maps them. */
export function decisionLine(
  action: string,
  after: Record<string, unknown> | null,
): string {
  const paise = Number(after?.amount ?? 0);
  const rupees = `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
  switch (action) {
    case "order.approve":
      return paise > 0 ? `Approved an order worth ${rupees}` : "Approved an order";
    case "order.decline":
      return `Declined an order${paise > 0 ? ` worth ${rupees}` : ""} — ${String(after?.reason ?? "no reason recorded")}`;
    case "payment.confirm":
      return `Confirmed ${rupees} received`;
    case "payment.reject":
      return `Rejected ${rupees} — ${String(after?.reason ?? "no reason recorded")}`;
    case "payment.record":
      return `Recorded ${rupees} as ${String(after?.status ?? "reported")}`;
    case "creditnote.issue":
      return `Issued a credit note for ${rupees}`;
    case "creditnote.refuse":
      return `Refused a credit note — ${String(after?.reason ?? "no reason recorded")}`;
    case "payment.apply_on_account":
      return `Applied ${rupees} from on account to ${String(after?.billNo ?? "a bill")}`;
    default:
      return action;
  }
}
