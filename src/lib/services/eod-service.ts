import "server-only";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  calls,
  complaints,
  customers,
  eodReports,
  followUpAttempts,
  monthlyTargets,
  orders,
  payments,
  reminders,
  users,
  waMessages,
} from "@/db/schema";
import { getConfig } from "../config/store";
import { resolveScope, scopedUserIds, requireCapability } from "../access-control";
import {
  aggregateEod,
  aggregateTeamEod,
  eodPreflight,
  type BlockingReminder,
  type EodInput,
} from "../engines/eod";
import { today } from "../recompute";
import {
  monthKey,
  rangeBoundaryWindow,
  type BusinessDate,
  type DateRange,
} from "../business-date";

/* ---------------------------------------------------------------------------
 * E6 wiring. Every figure is derived — missed calls come from the no-answer
 * connection status, never from anything a user typed.
 * ------------------------------------------------------------------------- */

async function windowFor(range: DateRange) {
  const config = await getConfig();
  return rangeBoundaryWindow(range, {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  });
}

/**
 * One day's figures. The EOD report's own view, and the dashboard's "today".
 *
 * A day is a range of one, and it is computed by the range function rather
 * than beside it: two copies of twenty subqueries is how the dashboard and
 * the EOD report come to disagree about how many calls somebody made.
 */
export async function eodMetricsFor(
  userId: string,
  day: BusinessDate,
): Promise<Omit<EodInput, "userName" | "date">> {
  return eodMetricsForRange(userId, { from: day, to: day });
}

/**
 * The same figures over a span of business days.
 *
 * Every count is over the span. The two MONTHLY figures are not, and cannot
 * be: a target is set for a calendar month, so it is read for the month the
 * span ends in whatever the span is. A week's progress against a month's
 * target is the honest reading of that pair; a target prorated to the span
 * would be a number nobody set.
 */
export async function eodMetricsForRange(
  userId: string,
  range: DateRange,
): Promise<Omit<EodInput, "userName" | "date">> {
  const w = await windowFor(range);
  const day = range.to;
  const period = monthKey(range.to);
  const [year, month] = period.split("-").map(Number);

  const [row] = await db.execute<Record<string, string>>(sql`
    select
      -- Order Received is NOT a call. Counting it here would inflate calls
      -- attempted, the connect rate and every per-call conversion metric.
      --
      -- Neither is an INBOUND call. You cannot fail to connect a call that
      -- rang your own phone, so counting inbound as "attempted and connected"
      -- moves the connect rate towards 100% on a day the telecaller made
      -- fewer calls, not more. Attempted and connected are both outbound
      -- only; inbound is counted separately and shown separately.
      (select count(*) from calls c where c.user_id = ${userId}
        and c.interaction_type = 'outbound_call'
        and c.started_at >= ${w.start}::timestamptz and c.started_at < ${w.end}::timestamptz)::int as calls_attempted,
      (select count(*) from calls c where c.user_id = ${userId}
        and c.interaction_type = 'outbound_call' and c.outcome <> 'no_answer'
        and c.started_at >= ${w.start}::timestamptz and c.started_at < ${w.end}::timestamptz)::int as calls_connected,
      (select count(*) from calls c where c.user_id = ${userId}
        and c.interaction_type = 'inbound_call'
        and c.started_at >= ${w.start}::timestamptz and c.started_at < ${w.end}::timestamptz)::int as calls_inbound,
      -- Missed reads the OUTCOME. connection_status is retired; reading it
      -- would have quietly made this number zero.
      (select count(*) from calls c where c.user_id = ${userId}
        and c.interaction_type = 'outbound_call' and c.outcome = 'no_answer'
        and c.started_at >= ${w.start}::timestamptz and c.started_at < ${w.end}::timestamptz)::int as calls_missed,
      -- Real work, but it must not hide inside the call count.
      (select count(*) from calls c where c.user_id = ${userId}
        and c.interaction_type = 'order_received'
        and c.started_at >= ${w.start}::timestamptz and c.started_at < ${w.end}::timestamptz)::int as orders_without_call,
      (select count(distinct c.customer_id) from calls c where c.user_id = ${userId}
        and c.source_module = 'call_queue'
        and c.started_at >= ${w.start}::timestamptz and c.started_at < ${w.end}::timestamptz)::int as queue_worked,
      -- The telecaller's own work: an order is taken the moment the customer
      -- says yes, whatever accounts decide about it afterwards. Cancelled is
      -- excluded because that order was withdrawn, not merely unapproved.
      (select count(*) from orders o where o.user_id = ${userId}
        and o.ordered_at >= ${w.start}::timestamptz and o.ordered_at < ${w.end}::timestamptz
        and o.status <> 'cancelled')::int as orders_captured,
      -- The sale. Only approved orders, because only those are money.
      (select count(*) from orders o where o.user_id = ${userId}
        and o.ordered_at >= ${w.start}::timestamptz and o.ordered_at < ${w.end}::timestamptz
        and o.status in ('captured','confirmed','dispatched'))::int as orders_count,
      (select coalesce(sum(o.total_amount),0) from orders o where o.user_id = ${userId}
        and o.ordered_at >= ${w.start}::timestamptz and o.ordered_at < ${w.end}::timestamptz
        and o.status in ('captured','confirmed','dispatched')) as orders_value,
      (select count(*) from follow_up_attempts a where a.user_id = ${userId}
        and a.attempted_at >= ${w.start}::timestamptz and a.attempted_at < ${w.end}::timestamptz)::int as follow_ups,
      (select count(*) from follow_up_attempts a where a.user_id = ${userId}
        and a.promised_amount is not null
        and a.attempted_at >= ${w.start}::timestamptz and a.attempted_at < ${w.end}::timestamptz)::int as promises_count,
      (select coalesce(sum(a.promised_amount),0) from follow_up_attempts a where a.user_id = ${userId}
        and a.attempted_at >= ${w.start}::timestamptz and a.attempted_at < ${w.end}::timestamptz) as promises_value,
      -- paid_at is a DATE, not a timestamp, so it is compared against the
      -- span's dates rather than its instants. Inclusive of both ends.
      (select coalesce(sum(p.amount),0) from payments p where p.recorded_by_id = ${userId}
        and p.paid_at >= ${range.from}::date and p.paid_at <= ${range.to}::date) as payments_confirmed,
      (select count(*) from reminders r where r.assigned_user_id = ${userId}
        and r.status = 'completed'
        and r.closed_at >= ${w.start}::timestamptz and r.closed_at < ${w.end}::timestamptz)::int as reminders_closed,
      (select count(*) from reminders r where r.created_by_user_id = ${userId}
        and r.created_at >= ${w.start}::timestamptz and r.created_at < ${w.end}::timestamptz)::int as reminders_created,
      (select count(*) from reminders r where r.assigned_user_id = ${userId}
        and r.status = 'pending' and r.due_date > ${day}::date and r.reschedule_count > 0
        and r.updated_at >= ${w.start}::timestamptz and r.updated_at < ${w.end}::timestamptz)::int as reminders_carried,
      (select count(*) from complaints cm where cm.logged_by_user_id = ${userId}
        and cm.created_at >= ${w.start}::timestamptz and cm.created_at < ${w.end}::timestamptz)::int as complaints_logged,
      (select count(*) from wa_messages m where m.user_id = ${userId}
        and m.status in ('sent_manually','sent','delivered','read')
        and coalesce(m.confirmed_sent_at, m.sent_at) >= ${w.start}::timestamptz
        and coalesce(m.confirmed_sent_at, m.sent_at) <  ${w.end}::timestamptz)::int as whatsapp_sent,
      (select coalesce(sum(t.target_amount),0) from monthly_targets t
        join customers cu on cu.id = t.customer_id
        where cu.owner_id = ${userId} and t.year = ${year} and t.month = ${month}) as target_amount,
      (select coalesce(sum(o.total_amount),0) from orders o
        join customers cu on cu.id = o.customer_id
        where cu.owner_id = ${userId}
          and o.status in ('captured','confirmed','dispatched')
          and extract(year from o.ordered_at) = ${year}
          and extract(month from o.ordered_at) = ${month}) as target_achieved
  `);

  const n = (k: string) => Number(row?.[k] ?? 0);

  return {
    callsAttempted: n("calls_attempted"),
    callsConnected: n("calls_connected"),
    callsInbound: n("calls_inbound"),
    callsMissed: n("calls_missed"),
    ordersWithoutCall: n("orders_without_call"),
    queueWorked: n("queue_worked"),
    ordersCaptured: n("orders_captured"),
    ordersCount: n("orders_count"),
    ordersValue: n("orders_value"),
    followUpsMade: n("follow_ups"),
    promisesCount: n("promises_count"),
    promisesValue: n("promises_value"),
    paymentsConfirmed: n("payments_confirmed"),
    remindersClosed: n("reminders_closed"),
    remindersCreated: n("reminders_created"),
    remindersCarriedForward: n("reminders_carried"),
    complaintsLogged: n("complaints_logged"),
    whatsappSent: n("whatsapp_sent"),
    targetAchieved: n("target_achieved"),
    targetAmount: n("target_amount"),
  };
}

export async function eodFor(userId: string, day: BusinessDate) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const metrics = await eodMetricsFor(userId, day);
  return aggregateEod({ userName: user?.name ?? "Unknown", date: day, ...metrics });
}

/** The reminders that block finalisation. */
export async function eodPreflightFor(userId: string, day: BusinessDate) {
  const rows = await db
    .select({
      id: reminders.id,
      note: reminders.note,
      dueDate: reminders.dueDate,
      customerName: customers.name,
    })
    .from(reminders)
    .innerJoin(customers, eq(customers.id, reminders.customerId))
    .where(
      and(
        eq(reminders.assignedUserId, userId),
        eq(reminders.status, "pending"),
        lte(reminders.dueDate, day),
      ),
    );

  const blocking: BlockingReminder[] = rows.map((r) => ({
    id: r.id,
    customerName: r.customerName,
    note: r.note,
    dueDate: r.dueDate,
  }));

  const result = eodPreflight(blocking);
  return result.canFinalise
    ? { canFinalise: true as const, blocking: [], message: "" }
    : { canFinalise: false as const, blocking: result.blocking, message: result.message };
}

export async function teamEod(day: BusinessDate) {
  await requireCapability("team.report");
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);

  const team = await db
    .select()
    .from(users)
    .where(and(eq(users.active, true), ids ? inArray(users.id, ids) : undefined));

  const rows = await Promise.all(
    team.map(async (u) => ({
      userName: u.name,
      ...(await eodMetricsFor(u.id, day)),
    })),
  );

  return aggregateTeamEod(day, rows);
}

export async function storedEodReport(userId: string, day: BusinessDate) {
  const [row] = await db
    .select()
    .from(eodReports)
    .where(and(eq(eodReports.userId, userId), eq(eodReports.day, day)));
  return row ?? null;
}

/** A zero-activity day still produces a report — absence must never be ambiguous. */
export async function autoGenerateEodReports(day?: BusinessDate): Promise<number> {
  const target = day ?? (await today());
  const team = await db.select().from(users).where(eq(users.active, true));

  let created = 0;
  for (const u of team) {
    const existing = await storedEodReport(u.id, target);
    if (existing) continue;

    const report = await eodFor(u.id, target);
    await db.insert(eodReports).values({
      id: `eod_${u.id.slice(-8)}_${target}`,
      userId: u.id,
      day: target,
      body: report.whatsappText,
      metrics: report.lines as never,
      autoGenerated: true,
    });
    created++;
  }
  return created;
}

export { calls, followUpAttempts, monthlyTargets, orders, payments, complaints, waMessages };
