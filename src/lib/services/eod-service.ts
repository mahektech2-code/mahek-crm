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
import { boxesFor } from "../catalogue";
import { HIGH_PRIORITY_REASON_KINDS } from "../queue-priority";
import {
  aggregateEod,
  aggregateTeamEod,
  eodPreflight,
  type BlockingReminder,
  type DashboardMetrics,
  type EodExtras,
  type EodInput,
} from "../engines/eod";
import { getPaymentFollowUpPlan } from "./payment-service";
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
 * One day's FULL figures — `DashboardMetrics` plus the EOD-only fields, for
 * callers that need the whole `EodInput` shape: the team roll-up, which
 * builds one `TeamRow` per member, and the auto-generation job. The
 * dashboard's own reads go through `eodMetricsForRange` directly instead —
 * see that function's comment for why.
 */
export async function eodMetricsFor(
  userId: string,
  day: BusinessDate,
): Promise<Omit<EodInput, "userName" | "date">> {
  const [dashboardMetrics, eodOnlyMetrics] = await Promise.all([
    eodMetricsForRange(userId, { from: day, to: day }),
    eodOnlyMetricsFor(userId, day),
  ]);
  return { ...dashboardMetrics, ...eodOnlyMetrics };
}

/**
 * The same figures over a span of business days. This is what the dashboard
 * calls directly — once per team member for a team view — so it carries only
 * `DashboardMetrics`: the day-only EOD fields (a settled queue snapshot, the
 * live collections worklist, today's order-line packing) are neither
 * meaningful over a range nor something every dashboard load should pay for.
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
): Promise<DashboardMetrics> {
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
      -- would have quietly made this number zero. This is also the EOD
      -- report's "No Answer" figure — one count, read once.
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

/**
 * The EOD-only fields `DashboardMetrics` deliberately excludes — a settled
 * queue snapshot, the live collections worklist, and today's order-line
 * packing. Always ONE day: none of these are meaningful summed over a range,
 * and `getPaymentFollowUpPlan` only ever answers for today regardless.
 */
async function eodOnlyMetricsFor(
  userId: string,
  day: BusinessDate,
): Promise<
  Pick<
    EodInput,
    | "callTarget"
    | "queueAssigned"
    | "highPriorityTotal"
    | "highPriorityCalled"
    | "ordersBoxes"
    | "ordersCans"
    | "noOrderCount"
    | "paymentCallsAssigned"
    | "paymentWaSent"
    | "paymentWaAssigned"
    | "followUpAssigned"
    | "followUpSent"
    | "followUpPending"
  >
> {
  const w = await windowFor({ from: day, to: day });
  const config = await getConfig();

  // Reused twice below (the settled-day total, and which of those rows carry
  // a high-priority reason) — one fragment, so the two queries cannot drift
  // on which reason kinds count as high priority. Kept in sync with
  // lib/queue-priority.ts by construction, not by two copies of the list.
  const priorityKinds = sql.join(
    HIGH_PRIORITY_REASON_KINDS.map((k) => sql`${k}`),
    sql`, `,
  );

  const [
    [row],
    { boxes, cans },
    plan,
    touchedCustomerIds,
  ] = await Promise.all([
    db.execute<Record<string, string>>(sql`
      select
        (select count(*) from calls c where c.user_id = ${userId}
          and c.interaction_type = 'outbound_call' and c.outcome = 'no_order'
          and c.started_at >= ${w.start}::timestamptz and c.started_at < ${w.end}::timestamptz)::int as no_order_count,
        -- The day's settled list for this user — see queueSnapshots in
        -- queue-service.ts. Read directly rather than through getQueue(),
        -- which resolves scope from the SIGNED-IN session and cannot be
        -- asked for an arbitrary user — this runs for every active user
        -- during team roll-ups and nightly auto-generation, neither of
        -- which is a session belonging to that user.
        (select count(*) from queue_snapshots qs where qs.user_id = ${userId}
          and qs.day = ${day}::date)::int as queue_assigned,
        (select count(*) from queue_snapshots qs where qs.user_id = ${userId}
          and qs.day = ${day}::date
          and exists (
            select 1 from jsonb_array_elements(qs.reasons) elem
            where elem->>'kind' in (${priorityKinds})
          ))::int as high_priority_total,
        (select count(distinct c.customer_id) from calls c where c.user_id = ${userId}
          and c.source_module = 'call_queue'
          and c.started_at >= ${w.start}::timestamptz and c.started_at < ${w.end}::timestamptz
          and c.customer_id in (
            select qs.customer_id from queue_snapshots qs where qs.user_id = ${userId}
              and qs.day = ${day}::date
              and exists (
                select 1 from jsonb_array_elements(qs.reasons) elem
                where elem->>'kind' in (${priorityKinds})
              )
          ))::int as high_priority_called,
        (select count(*) from wa_messages m
          join wa_templates t on t.id = m.template_id
          where m.user_id = ${userId} and t.category = 'payment_reminder'
            and m.status in ('sent_manually','sent','delivered','read')
            and coalesce(m.confirmed_sent_at, m.sent_at) >= ${w.start}::timestamptz
            and coalesce(m.confirmed_sent_at, m.sent_at) <  ${w.end}::timestamptz)::int as payment_wa_sent
    `),
    orderQuantityFor(userId, w),
    getPaymentFollowUpPlan(userId),
    paymentTouchedCustomersFor(userId, w),
  ]);

  const n = (k: string) => Number(row?.[k] ?? 0);

  // The LIVE plan already excludes anybody contacted today — see
  // planPaymentFollowUps's own `contactedToday` handling — so its size IS the
  // day's remaining, still-pending collections work at the moment this report
  // is generated. "Assigned" is that plus whoever has already been touched;
  // arithmetic, not a second read, so assigned always equals sent + pending.
  const pendingIds = new Set([
    ...plan.calls.map((c) => c.customerId),
    ...plan.messages.map((c) => c.customerId),
  ]);
  const followUpPending = pendingIds.size;
  const followUpSent = touchedCustomerIds.size;

  return {
    callTarget: config["targets.dailyCallTarget"],
    queueAssigned: n("queue_assigned"),
    highPriorityTotal: n("high_priority_total"),
    highPriorityCalled: n("high_priority_called"),
    ordersBoxes: boxes,
    ordersCans: cans,
    noOrderCount: n("no_order_count"),
    paymentCallsAssigned: plan.calls.length,
    paymentWaSent: n("payment_wa_sent"),
    paymentWaAssigned: plan.messages.length,
    followUpAssigned: followUpPending + followUpSent,
    followUpSent,
    followUpPending,
  };
}

/** Today's captured order lines, rolled into boxes and loose cans via lib/catalogue.ts. */
async function orderQuantityFor(
  userId: string,
  w: { start: string; end: string },
): Promise<{ boxes: number; cans: number }> {
  const rows = await db.execute<{
    quantity: string;
    millilitres_per_can: string | null;
    cans_per_box: string;
  }>(sql`
    select l.quantity, p.millilitres_per_can, p.cans_per_box
    from interaction_product_lines l
    join calls c on c.id = l.interaction_id
    join products p on p.id = l.product_id
    where c.user_id = ${userId}
      and c.started_at >= ${w.start}::timestamptz and c.started_at < ${w.end}::timestamptz
  `);

  let boxes = 0;
  let cans = 0;
  for (const r of rows) {
    const { boxes: b, looseCans } = boxesFor(Number(r.quantity), {
      millilitresPerCan: r.millilitres_per_can == null ? null : Number(r.millilitres_per_can),
      cansPerBox: Number(r.cans_per_box),
    });
    boxes += b;
    cans += looseCans;
  }
  return { boxes, cans };
}

/** Today's "No order" calls, tallied by which quick note was picked. */
async function noOrderReasonsFor(
  userId: string,
  w: { start: string; end: string },
): Promise<EodExtras["noOrderReasons"]> {
  const rows = await db.execute<{ label: string; cnt: string }>(sql`
    select qn.label, count(*)::int as cnt
    from calls c
    cross join lateral jsonb_array_elements_text(c.quick_note_ids) as qnid
    join quick_notes qn on qn.id = qnid
    where c.user_id = ${userId}
      and c.interaction_type = 'outbound_call'
      and c.outcome = 'no_order'
      and c.started_at >= ${w.start}::timestamptz and c.started_at < ${w.end}::timestamptz
    group by qn.label
    order by cnt desc
  `);
  return rows.map((r) => ({ label: r.label, count: Number(r.cnt) }));
}

/** Distinct customers touched today via either collections channel. */
async function paymentTouchedCustomersFor(
  userId: string,
  w: { start: string; end: string },
): Promise<Set<string>> {
  const [callRows, waRows] = await Promise.all([
    db.execute<{ customer_id: string }>(sql`
      select distinct a.customer_id
      from follow_up_attempts a
      where a.user_id = ${userId} and a.channel = 'call'
        and a.attempted_at >= ${w.start}::timestamptz and a.attempted_at < ${w.end}::timestamptz
    `),
    db.execute<{ customer_id: string }>(sql`
      select distinct m.customer_id
      from wa_messages m join wa_templates t on t.id = m.template_id
      where m.user_id = ${userId} and t.category = 'payment_reminder'
        and m.status in ('sent_manually','sent','delivered','read')
        and coalesce(m.confirmed_sent_at, m.sent_at) >= ${w.start}::timestamptz
        and coalesce(m.confirmed_sent_at, m.sent_at) <  ${w.end}::timestamptz
    `),
  ]);
  return new Set([
    ...callRows.map((r) => r.customer_id),
    ...waRows.map((r) => r.customer_id),
  ]);
}

/** Today's payment promises, name and date, newest first. */
async function promisesFor(
  userId: string,
  w: { start: string; end: string },
): Promise<EodExtras["promises"]> {
  const rows = await db.execute<{ customer_name: string; promised_date: string }>(sql`
    select c.name as customer_name, a.promised_date
    from follow_up_attempts a
    join customers c on c.id = a.customer_id
    where a.user_id = ${userId}
      and a.promised_date is not null
      and a.attempted_at >= ${w.start}::timestamptz and a.attempted_at < ${w.end}::timestamptz
    order by a.attempted_at desc
    limit 10
  `);
  return rows.map((r) => ({ customerName: r.customer_name, date: r.promised_date as BusinessDate }));
}

/**
 * The full report for one telecaller: every `EodInput` field plus the two
 * list-shaped extras (no-order reasons, promises) — per-telecaller detail a
 * team roll-up has no room for, so they are fetched only here.
 */
export async function eodFor(userId: string, day: BusinessDate) {
  const w = await windowFor({ from: day, to: day });
  const [user, metrics, noOrderReasons, promises] = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)).then((r) => r[0]),
    eodMetricsFor(userId, day),
    noOrderReasonsFor(userId, w),
    promisesFor(userId, w),
  ]);
  const extras: EodExtras = { noOrderReasons, promises };
  return aggregateEod({ userName: user?.name ?? "Unknown", date: day, ...metrics }, extras);
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
