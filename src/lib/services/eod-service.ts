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
import { DEFAULT_TIER_WEIGHTS } from "../config/registry";
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
      -- Single-select outcome (interactions.singleSelectOutcomes), so the
      -- count is over calls, not over reasons — the breakdown by WHICH
      -- reason is its own query below, run once rather than per row here.
      (select count(*) from calls c where c.user_id = ${userId}
        and c.interaction_type = 'outbound_call' and c.outcome = 'no_order'
        and c.started_at >= ${w.start}::timestamptz and c.started_at < ${w.end}::timestamptz)::int as no_order_count,
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

  // Why not one this size mega-query: the queue and box/can pieces both need
  // a JSONB unnest (reasons, line items), which does not compose cleanly as
  // a scalar subquery beside the counts above. Four small round trips over
  // one giant one, for a screen read a handful of times a day per person.
  const [queueRow] = await db.execute<Record<string, string>>(sql`
    with pay_ids as (
      select distinct customer_id
      from queue_snapshots
      where user_id = ${userId} and day >= ${range.from}::date and day <= ${range.to}::date
        and exists (
          select 1 from jsonb_array_elements(reasons) r where r->>'kind' = 'paymentOverdue'
        )
    ),
    called_today as (
      select distinct c.customer_id from calls c
      where c.user_id = ${userId} and c.source_module = 'call_queue'
        and c.started_at >= ${w.start}::timestamptz and c.started_at < ${w.end}::timestamptz
    ),
    wa_today as (
      select distinct m.customer_id from wa_messages m
      where m.user_id = ${userId}
        and m.status in ('sent_manually','sent','delivered','read')
        and coalesce(m.confirmed_sent_at, m.sent_at) >= ${w.start}::timestamptz
        and coalesce(m.confirmed_sent_at, m.sent_at) <  ${w.end}::timestamptz
    )
    select
      -- The frozen composition itself, not a live rebuild — see the
      -- queueAssigned doc comment on EodInput.
      (select count(*) from queue_snapshots qs where qs.user_id = ${userId}
        and qs.day >= ${range.from}::date and qs.day <= ${range.to}::date)::int as queue_assigned,
      (select count(*) from queue_snapshots qs where qs.user_id = ${userId}
        and qs.day >= ${range.from}::date and qs.day <= ${range.to}::date
        and qs.score > ${DEFAULT_TIER_WEIGHTS.routineCall}
        and qs.customer_id not in (select customer_id from called_today))::int as high_priority_pending,
      (select count(*) from pay_ids)::int as payment_assigned,
      (select count(*) from pay_ids p where p.customer_id in (select customer_id from called_today))::int as payment_calls_made,
      (select count(*) from pay_ids p where p.customer_id in (select customer_id from wa_today))::int as payment_wa_sent,
      (select count(*) from pay_ids p
        where p.customer_id in (select customer_id from called_today)
           or p.customer_id in (select customer_id from wa_today))::int as payment_actioned
  `);
  const qn = (k: string) => Number(queueRow?.[k] ?? 0);

  const noOrderReasonRows = await db.execute<{ label: string; n: string }>(sql`
    select coalesce(qn.label, 'Other') as label, count(*)::int as n
    from calls c
    left join quick_notes qn on qn.id = (c.quick_note_ids ->> 0)
    where c.user_id = ${userId}
      and c.interaction_type = 'outbound_call' and c.outcome = 'no_order'
      and c.started_at >= ${w.start}::timestamptz and c.started_at < ${w.end}::timestamptz
    group by coalesce(qn.label, 'Other')
    order by count(*) desc
  `);
  const noOrderReasons = (noOrderReasonRows as unknown as { label: string; n: number }[]).map(
    (r) => ({ label: r.label, count: Number(r.n) }),
  );

  // Boxes and loose cans, matched per line against its own SKU's packing —
  // a formulation's own box size, never a flat divisor across every line.
  // A product name the catalogue does not recognise contributes nothing,
  // same as everywhere else an unmatched name is read (see product-service.ts).
  const [boxRow] = await db.execute<Record<string, string>>(sql`
    with today_orders as (
      select o.line_items
      from orders o
      where o.user_id = ${userId}
        and o.ordered_at >= ${w.start}::timestamptz and o.ordered_at < ${w.end}::timestamptz
        and o.status in ('captured','confirmed','dispatched')
    ),
    lines as (
      select (li ->> 'product') as product_name, (li ->> 'quantity')::int as qty
      from today_orders, jsonb_array_elements(coalesce(line_items, '[]'::jsonb)) as li
    ),
    matched as (
      select l.qty, p.cans_per_box
      from lines l
      join products p on
        lower(regexp_replace(p.name, '[^a-zA-Z0-9]', '', 'g'))
          = lower(regexp_replace(l.product_name, '[^a-zA-Z0-9]', '', 'g'))
        or exists (
          select 1 from product_aliases pa
          where pa.product_id = p.id
            and lower(regexp_replace(pa.name, '[^a-zA-Z0-9]', '', 'g'))
              = lower(regexp_replace(l.product_name, '[^a-zA-Z0-9]', '', 'g'))
        )
    )
    select
      coalesce(sum(floor(qty::numeric / greatest(cans_per_box, 1))), 0)::int as boxes,
      coalesce(sum(qty % greatest(cans_per_box, 1)), 0)::int as loose_cans
    from matched
  `);
  const bn = (k: string) => Number(boxRow?.[k] ?? 0);

  const promisedRows = await db
    .select({ name: customers.name, date: followUpAttempts.promisedDate })
    .from(followUpAttempts)
    .innerJoin(customers, eq(customers.id, followUpAttempts.customerId))
    .where(
      and(
        eq(followUpAttempts.userId, userId),
        sql`${followUpAttempts.promisedAmount} is not null`,
        sql`${followUpAttempts.attemptedAt} >= ${w.start}::timestamptz`,
        sql`${followUpAttempts.attemptedAt} <  ${w.end}::timestamptz`,
      ),
    )
    .orderBy(followUpAttempts.attemptedAt);

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
    ordersBoxes: bn("boxes"),
    ordersLooseCans: bn("loose_cans"),
    followUpsMade: n("follow_ups"),
    promisesCount: n("promises_count"),
    promisesValue: n("promises_value"),
    paymentsConfirmed: n("payments_confirmed"),
    promisedCustomers: promisedRows.map((r) => ({ name: r.name, date: r.date })),
    remindersClosed: n("reminders_closed"),
    remindersCreated: n("reminders_created"),
    remindersCarriedForward: n("reminders_carried"),
    complaintsLogged: n("complaints_logged"),
    whatsappSent: n("whatsapp_sent"),
    noOrderCount: n("no_order_count"),
    noOrderReasons,
    queueAssigned: qn("queue_assigned"),
    highPriorityPending: qn("high_priority_pending"),
    paymentAssigned: qn("payment_assigned"),
    paymentCallsMade: qn("payment_calls_made"),
    paymentWaSent: qn("payment_wa_sent"),
    paymentActioned: qn("payment_actioned"),
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

/**
 * The team roll-up over any span — `range` of one day is what the default
 * "today" view passes, so this is unchanged for that case and simply widens
 * for the others. `aggregateTeamEod` still takes a single `BusinessDate` for
 * its own paste-ready message, which is why `range.to` is what it gets: the
 * table of rows and totals this returns is correct over any span, and the
 * screen only offers that message where `range` really is one day.
 */
export async function teamEod(range: DateRange) {
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
      ...(await eodMetricsForRange(u.id, range)),
    })),
  );

  return aggregateTeamEod(range.to, rows);
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
