import "server-only";
import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  bills,
  complaints,
  customers,
  eodReports,
  helpArticles,
  interactions,
  notifications,
  orders,
  promises,
  queueItems,
  reminders,
  targets,
  users,
  waMessages,
  waReplies,
  waRuns,
  waTemplates,
  type Customer,
  type User,
} from "@/db/schema";
import {
  agingBucket,
  daysBetween,
  toISODate,
  pct,
  today,
} from "./format";
import { isManager } from "./auth";
import type { Scope } from "./scope";

/* ---------------------------------------------------------------------------
 * One read layer. Every screen derives from these functions so that a number
 * shown on the dashboard and the same number shown on its own screen are the
 * same computation, not two that drifted apart.
 * ------------------------------------------------------------------------- */

export { today };

export function currentPeriod(): string {
  return today().slice(0, 7);
}

/** Owner filter for the current scope — undefined means "no filter". */
function ownerFilter(user: User, scope: Scope) {
  return scope === "team" && isManager(user) ? undefined : user.id;
}

/**
 * The CRM's team is whoever can open the CRM — not everyone with a login. A
 * field salesman has a MahekOne account but no business appearing in the
 * telecaller comparison table.
 */
export async function listTeam() {
  return db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      passwordHash: users.passwordHash,
      role: users.role,
      initials: users.initials,
      active: users.active,
      createdAt: users.createdAt,
    })
    .from(users)
    .innerJoin(
      appAccess,
      and(eq(appAccess.userId, users.id), eq(appAccess.app, "crm")),
    )
    .where(eq(users.active, true))
    .orderBy(asc(users.name));
}

/* ------------------------------------------------------------- customers */

export type CustomerRow = Customer & {
  ownerName: string | null;
  openComplaints: number;
};

export async function listCustomers(
  user: User,
  scope: Scope,
): Promise<CustomerRow[]> {
  const owner = ownerFilter(user, scope);

  const rows = await db
    .select({
      customer: customers,
      ownerName: users.name,
      openComplaints: sql<number>`(
        select count(*)::int from ${complaints}
        where ${complaints.customerId} = ${customers.id}
          and ${complaints.status} in ('Open','In progress')
      )`,
    })
    .from(customers)
    .leftJoin(users, eq(users.id, customers.ownerId))
    .where(owner ? eq(customers.ownerId, owner) : undefined)
    .orderBy(asc(customers.name));

  return rows.map((r) => ({
    ...r.customer,
    ownerName: r.ownerName,
    openComplaints: r.openComplaints,
  }));
}

export async function getCustomer(id: string) {
  const rows = await db
    .select({ customer: customers, ownerName: users.name })
    .from(customers)
    .leftJoin(users, eq(users.id, customers.ownerId))
    .where(eq(customers.id, id))
    .limit(1);
  if (!rows[0]) return null;
  return { ...rows[0].customer, ownerName: rows[0].ownerName };
}

/* ----------------------------------------------------------------- queue */

export type QueueRow = {
  id: string;
  customer: Customer;
  reason: string;
  priority: number;
  worked: boolean;
  skipped: boolean;
  heldBackReason: string | null;
  lastNote: string | null;
  openComplaint: string | null;
};

export async function listQueue(
  user: User,
  scope: Scope,
  day = today(),
): Promise<QueueRow[]> {
  const owner = ownerFilter(user, scope);

  const rows = await db
    .select({
      item: queueItems,
      customer: customers,
      lastNote: sql<string | null>`(
        select ${interactions.note} from ${interactions}
        where ${interactions.customerId} = ${customers.id}
          and ${interactions.note} is not null
        order by ${interactions.occurredAt} desc limit 1
      )`,
      openComplaint: sql<string | null>`(
        select ${complaints.description} from ${complaints}
        where ${complaints.customerId} = ${customers.id}
          and ${complaints.status} in ('Open','In progress')
        order by ${complaints.loggedOn} asc limit 1
      )`,
    })
    .from(queueItems)
    .innerJoin(customers, eq(customers.id, queueItems.customerId))
    .where(
      and(
        eq(queueItems.day, day),
        owner ? eq(queueItems.ownerId, owner) : undefined,
      ),
    )
    .orderBy(asc(queueItems.priority), asc(customers.name));

  return rows.map((r) => ({
    id: r.item.id,
    customer: r.customer,
    reason: r.item.reason,
    priority: r.item.priority,
    worked: r.item.worked,
    skipped: r.item.skipped,
    heldBackReason: r.item.heldBackReason,
    lastNote: r.lastNote,
    openComplaint: r.openComplaint,
  }));
}

/* ------------------------------------------------------------- reminders */

export type ReminderRow = {
  id: string;
  customerId: string;
  customerName: string;
  userId: string;
  userName: string;
  dueDate: string;
  note: string;
  source: string;
  status: "open" | "done" | "cancelled";
  overdueDays: number;
};

export async function listReminders(
  user: User,
  scope: Scope,
): Promise<ReminderRow[]> {
  const owner = ownerFilter(user, scope);
  const rows = await db
    .select({
      reminder: reminders,
      customerName: customers.name,
      userName: users.name,
    })
    .from(reminders)
    .innerJoin(customers, eq(customers.id, reminders.customerId))
    .innerJoin(users, eq(users.id, reminders.userId))
    .where(owner ? eq(reminders.userId, owner) : undefined)
    .orderBy(asc(reminders.dueDate));

  const t = today();
  return rows.map((r) => ({
    id: r.reminder.id,
    customerId: r.reminder.customerId,
    customerName: r.customerName,
    userId: r.reminder.userId,
    userName: r.userName,
    dueDate: r.reminder.dueDate,
    note: r.reminder.note,
    source: r.reminder.source,
    status: r.reminder.status,
    overdueDays: Math.max(0, daysBetween(r.reminder.dueDate, t)),
  }));
}

/* ----------------------------------------------------------------- bills */

export type BillRow = {
  id: string;
  billNo: string;
  customerId: string;
  customerName: string;
  billDate: string;
  dueDate: string;
  amount: number;
  paid: number;
  balance: number;
  overdueDays: number;
  bucket: string;
  status: "Unpaid" | "Partly paid" | "Paid";
};

export async function listBills(
  user: User,
  scope: Scope,
): Promise<BillRow[]> {
  const owner = ownerFilter(user, scope);
  const rows = await db
    .select({ bill: bills, customerName: customers.name })
    .from(bills)
    .innerJoin(customers, eq(customers.id, bills.customerId))
    .where(owner ? eq(customers.ownerId, owner) : undefined)
    .orderBy(desc(bills.billDate));

  const t = today();
  return rows.map((r) => {
    const balance = r.bill.amount - r.bill.paid;
    const overdueDays = balance > 0 ? Math.max(0, daysBetween(r.bill.dueDate, t)) : 0;
    return {
      id: r.bill.id,
      billNo: r.bill.billNo,
      customerId: r.bill.customerId,
      customerName: r.customerName,
      billDate: r.bill.billDate,
      dueDate: r.bill.dueDate,
      amount: r.bill.amount,
      paid: r.bill.paid,
      balance,
      overdueDays,
      bucket: agingBucket(overdueDays),
      status:
        balance <= 0 ? "Paid" : r.bill.paid > 0 ? "Partly paid" : "Unpaid",
    };
  });
}

/* -------------------------------------------------------------- payments */

export type PaymentStage =
  | "Reminder due"
  | "Stage 1 sent"
  | "Stage 2 sent"
  | "Promise made"
  | "Promise broken"
  | "Escalate";

export type PayRow = {
  customer: Customer;
  ownerName: string | null;
  outstanding: number;
  billsOverdue: number;
  oldestDays: number;
  lastFollowUp: string | null;
  stage: PaymentStage;
  nextAction: string;
  promiseAmount: number | null;
  promiseBy: string | null;
};

export async function listPaymentFollowUps(
  user: User,
  scope: Scope,
): Promise<PayRow[]> {
  const owner = ownerFilter(user, scope);
  const t = today();

  const rows = await db
    .select({
      customer: customers,
      ownerName: users.name,
      billsOverdue: sql<number>`(
        select count(*)::int from ${bills}
        where ${bills.customerId} = ${customers.id}
          and ${bills.amount} > ${bills.paid}
          and ${bills.dueDate} < ${t}
      )`,
      oldestDue: sql<string | null>`(
        select min(${bills.dueDate}) from ${bills}
        where ${bills.customerId} = ${customers.id}
          and ${bills.amount} > ${bills.paid}
          and ${bills.dueDate} < ${t}
      )`,
      lastFollowUp: sql<string | null>`(
        select max(${interactions.occurredAt})::text from ${interactions}
        where ${interactions.customerId} = ${customers.id}
      )`,
      stageSent: sql<number>`(
        select count(*)::int from ${waMessages}
        where ${waMessages.customerId} = ${customers.id}
          and ${waMessages.status} in ('Sent','Delivered','Read')
          and ${waMessages.templateName} ilike '%payment%'
      )`,
      promiseAmount: sql<number | null>`(
        select ${promises.amount} from ${promises}
        where ${promises.customerId} = ${customers.id} and ${promises.kept} is null
        order by ${promises.createdAt} desc limit 1
      )`,
      promiseBy: sql<string | null>`(
        select ${promises.promisedBy} from ${promises}
        where ${promises.customerId} = ${customers.id} and ${promises.kept} is null
        order by ${promises.createdAt} desc limit 1
      )`,
    })
    .from(customers)
    .leftJoin(users, eq(users.id, customers.ownerId))
    .where(
      and(
        sql`${customers.outstanding} > 0`,
        eq(customers.active, true),
        owner ? eq(customers.ownerId, owner) : undefined,
      ),
    )
    .orderBy(desc(customers.outstanding));

  return rows
    .filter((r) => r.billsOverdue > 0)
    .map((r) => {
      const oldestDays = r.oldestDue ? daysBetween(r.oldestDue, t) : 0;
      const promiseBroken =
        r.promiseBy != null && daysBetween(r.promiseBy, t) > 0;

      let stage: PaymentStage;
      if (promiseBroken) stage = "Promise broken";
      else if (r.promiseBy) stage = "Promise made";
      else if (oldestDays > 90) stage = "Escalate";
      else if (r.stageSent >= 2) stage = "Stage 2 sent";
      else if (r.stageSent === 1) stage = "Stage 1 sent";
      else stage = "Reminder due";

      const nextAction: Record<PaymentStage, string> = {
        "Reminder due": "Send stage 1 reminder",
        "Stage 1 sent": "Call and confirm",
        "Stage 2 sent": "Get a dated promise",
        "Promise made": "Wait for the promised date",
        "Promise broken": "Call — promise missed",
        Escalate: "Escalate to the manager",
      };

      return {
        customer: r.customer,
        ownerName: r.ownerName,
        outstanding: r.customer.outstanding,
        billsOverdue: r.billsOverdue,
        oldestDays,
        lastFollowUp: r.lastFollowUp,
        stage,
        nextAction: nextAction[stage],
        promiseAmount: r.promiseAmount,
        promiseBy: r.promiseBy,
      };
    });
}

/* ------------------------------------------------------- inactive watch */

export type InactiveRow = {
  customer: Customer;
  daysSince: number;
  multiple: number;
  valueAtRisk: number;
  lastContact: Date | null;
  ageWithoutDecision: number;
};

export async function listInactive(
  user: User,
  scope: Scope,
): Promise<InactiveRow[]> {
  const owner = ownerFilter(user, scope);
  const t = today();

  const rows = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.active, true),
        owner ? eq(customers.ownerId, owner) : undefined,
      ),
    );

  return rows
    .map((c) => {
      const daysSince = c.lastOrderDate ? daysBetween(c.lastOrderDate, t) : 999;
      const multiple = c.cycleDays ? daysSince / c.cycleDays : 0;
      return {
        customer: c,
        daysSince,
        multiple: Math.round(multiple * 10) / 10,
        // Six months of business at their normal rate, at risk.
        valueAtRisk: Math.round((c.avgOrderValue * 180) / (c.cycleDays || 30)),
        lastContact: c.lastContactAt,
        ageWithoutDecision: c.lastContactAt
          ? daysBetween(toISODate(c.lastContactAt), t)
          : daysSince,
      };
    })
    .filter((r) => r.multiple >= 2)
    .sort((a, b) => b.valueAtRisk - a.valueAtRisk);
}

/* ------------------------------------------------------------- complaints */

export type ComplaintRow = {
  id: string;
  customerId: string;
  customerName: string;
  category: string;
  description: string;
  loggedByName: string;
  loggedOn: string;
  assignedTo: string;
  status: "Open" | "In progress" | "Resolved" | "Closed";
  ageDays: number;
  resolutionNote: string | null;
  customerTold: boolean;
};

export async function listComplaints(
  user: User,
  scope: Scope,
): Promise<ComplaintRow[]> {
  const owner = ownerFilter(user, scope);
  const rows = await db
    .select({
      complaint: complaints,
      customerName: customers.name,
      loggedByName: users.name,
    })
    .from(complaints)
    .innerJoin(customers, eq(customers.id, complaints.customerId))
    .innerJoin(users, eq(users.id, complaints.loggedById))
    .where(owner ? eq(customers.ownerId, owner) : undefined)
    .orderBy(asc(complaints.loggedOn));

  const t = today();
  return rows.map((r) => ({
    id: r.complaint.id,
    customerId: r.complaint.customerId,
    customerName: r.customerName,
    category: r.complaint.category,
    description: r.complaint.description,
    loggedByName: r.loggedByName,
    loggedOn: r.complaint.loggedOn,
    assignedTo: r.complaint.assignedTo,
    status: r.complaint.status,
    ageDays: daysBetween(r.complaint.loggedOn, t),
    resolutionNote: r.complaint.resolutionNote,
    customerTold: r.complaint.customerTold,
  }));
}

export async function getComplaintEvents(complaintId: string) {
  return db.query.complaintEvents.findMany({
    where: (e, { eq }) => eq(e.complaintId, complaintId),
    orderBy: (e, { asc }) => asc(e.at),
  });
}

/** Every complaint's history in one query, keyed by complaint. */
export async function complaintEventsFor(
  complaintIds: string[],
): Promise<Record<string, Array<{ at: string; note: string }>>> {
  if (!complaintIds.length) return {};

  const rows = await db.query.complaintEvents.findMany({
    where: (e, { inArray }) => inArray(e.complaintId, complaintIds),
    orderBy: (e, { asc }) => asc(e.at),
  });

  const out: Record<string, Array<{ at: string; note: string }>> = {};
  for (const id of complaintIds) out[id] = [];
  for (const e of rows) {
    out[e.complaintId]?.push({ at: e.at.toISOString(), note: e.note });
  }
  return out;
}

/* ---------------------------------------------------------------- history */

export type InteractionRow = {
  id: string;
  occurredAt: Date;
  customerId: string;
  customerName: string;
  userName: string;
  channel: string;
  connection: string | null;
  outcome: string | null;
  note: string | null;
  produced: string | null;
};

export async function listInteractions(
  user: User,
  scope: Scope,
  limit = 400,
): Promise<InteractionRow[]> {
  const owner = ownerFilter(user, scope);
  const rows = await db
    .select({
      interaction: interactions,
      customerName: customers.name,
      userName: users.name,
    })
    .from(interactions)
    .innerJoin(customers, eq(customers.id, interactions.customerId))
    .innerJoin(users, eq(users.id, interactions.userId))
    .where(owner ? eq(interactions.userId, owner) : undefined)
    .orderBy(desc(interactions.occurredAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.interaction.id,
    occurredAt: r.interaction.occurredAt,
    customerId: r.interaction.customerId,
    customerName: r.customerName,
    userName: r.userName,
    channel: r.interaction.channel,
    connection: r.interaction.connection,
    outcome: r.interaction.outcome,
    note: r.interaction.note,
    produced: r.interaction.produced,
  }));
}

/* --------------------------------------------------------- customer record */

export type TimelineEntry = {
  id: string;
  kind: "Call" | "WhatsApp" | "Order" | "Reminder" | "Complaint" | "Payment" | "Bill";
  at: Date;
  actor: string;
  content: string;
  meta?: string;
};

export async function customerTimeline(
  customerId: string,
): Promise<TimelineEntry[]> {
  // One round trip, not seven. Against a database 300 ms away, a query per
  // entry type is two seconds of nothing but waiting.
  const rows = await db.execute<{
    id: string;
    kind: TimelineEntry["kind"];
    at: Date;
    actor: string;
    content: string;
    meta: string | null;
  }>(sql`
    select i.id, 'Call' as kind, i.occurred_at as at, u.name as actor,
           coalesce(i.note, i.outcome, 'Call logged') as content,
           nullif(concat_ws(' · ', i.connection, i.outcome), '') as meta
      from interactions i join users u on u.id = i.user_id
     where i.customer_id = ${customerId} and i.channel = 'Call'
    union all
    select m.id, 'WhatsApp', m.created_at, u.name,
           coalesce(m.template_name, 'WhatsApp message'),
           concat_ws(' · ', m.destination, m.status,
                     case when m.edited then 'edited from template' end)
      from wa_messages m join users u on u.id = m.sent_by_id
     where m.customer_id = ${customerId}
    union all
    select o.id, 'Order', o.placed_at, u.name,
           concat(o.product, ' × ', o.quantity),
           concat('Order value ₹', to_char(round(o.value / 100.0), 'FM9G99G99G999'))
      from orders o join users u on u.id = o.user_id
     where o.customer_id = ${customerId}
    union all
    select r.id, 'Reminder', r.created_at, u.name, r.note,
           concat('Due ', to_char(r.due_date, 'DD Mon'), ' · ', r.status)
      from reminders r join users u on u.id = r.user_id
     where r.customer_id = ${customerId}
    union all
    select c.id, 'Complaint', c.logged_on::timestamptz, u.name, c.description,
           concat(c.category, ' · ', c.status)
      from complaints c join users u on u.id = c.logged_by_id
     where c.customer_id = ${customerId}
    union all
    select p.id, 'Payment', p.received_on::timestamptz, 'Accounts',
           concat('Payment received ₹', to_char(round(p.amount / 100.0), 'FM9G99G99G999')),
           concat_ws(' · ', p.mode, p.reference)
      from payments p
     where p.customer_id = ${customerId}
    union all
    select b.id, 'Bill', b.bill_date::timestamptz, 'Accounts',
           concat('Bill ', b.bill_no, ' raised'),
           concat('₹', to_char(round(b.amount / 100.0), 'FM9G99G99G999'),
                  ' · due ', to_char(b.due_date, 'DD Mon'))
      from bills b
     where b.customer_id = ${customerId}
    order by at desc
  `);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    at: new Date(r.at),
    actor: r.actor,
    content: r.content,
    meta: r.meta ?? undefined,
  }));
}

/* ----------------------------------------------------------------- targets */

export type TargetRow = {
  customerId: string;
  customerName: string;
  ownerName: string | null;
  target: number;
  achieved: number;
  gap: number;
  percent: number;
  isDefault: boolean;
  lastContact: Date | null;
  cycleDays: number;
};

export async function listTargets(
  user: User,
  scope: Scope,
  period = currentPeriod(),
): Promise<TargetRow[]> {
  const owner = ownerFilter(user, scope);
  const monthStart = `${period}-01`;

  const rows = await db
    .select({
      customer: customers,
      ownerName: users.name,
      target: targets.amount,
      isDefault: targets.isDefault,
      achieved: sql<number>`coalesce((
        select sum(${orders.value})::bigint from ${orders}
        where ${orders.customerId} = ${customers.id}
          and ${orders.placedAt} >= ${monthStart}::date
          and ${orders.placedAt} < (${monthStart}::date + interval '1 month')
      ), 0)`,
    })
    .from(customers)
    .leftJoin(users, eq(users.id, customers.ownerId))
    .leftJoin(
      targets,
      and(eq(targets.customerId, customers.id), eq(targets.period, period)),
    )
    .where(
      and(
        eq(customers.active, true),
        owner ? eq(customers.ownerId, owner) : undefined,
      ),
    )
    .orderBy(asc(customers.name));

  return rows.map((r) => {
    // No target set? Apply the customer's own run-rate as a default, and say so.
    const fallback = Math.round((r.customer.avgOrderValue * 30) / (r.customer.cycleDays || 30));
    const target = r.target ?? fallback;
    const achieved = Number(r.achieved ?? 0);
    return {
      customerId: r.customer.id,
      customerName: r.customer.name,
      ownerName: r.ownerName,
      target,
      achieved,
      gap: Math.max(0, target - achieved),
      percent: pct(achieved, target),
      isDefault: r.isDefault ?? true,
      lastContact: r.customer.lastContactAt,
      cycleDays: r.customer.cycleDays,
    };
  });
}

/* ------------------------------------------------------------ daily figures */

export type DayActivity = {
  attempted: number;
  connected: number;
  missed: number;
  connectRate: number;
  orders: number;
  orderValue: number;
  collected: number;
  remindersSet: number;
  remindersClosed: number;
  complaintsLogged: number;
  messagesSent: number;
  queueWorked: number;
  queueTotal: number;
};

export async function dayActivity(
  userId: string | null,
  day = today(),
): Promise<DayActivity> {
  // Pin the window to IST explicitly. Without the offset Postgres reads these
  // in the server's timezone, and a call logged at 9 am IST lands outside
  // "today" whenever the server runs in UTC.
  const start = `${day}T00:00:00+05:30`;
  const end = `${day}T23:59:59.999+05:30`;

  // One round trip. These figures are read on nearly every screen, so seven
  // sequential queries here was two seconds added to each of them.
  const [row] = await db.execute<{
    attempted: number;
    connected: number;
    missed: number;
    orders: number;
    order_value: string;
    collected: string;
    reminders_set: number;
    reminders_closed: number;
    complaints_logged: number;
    messages_sent: number;
    queue_total: number;
    queue_worked: number;
  }>(sql`
    select
      (select count(*) from interactions i
        where i.channel = 'Call' and i.occurred_at between ${start} and ${end}
          and (${userId}::text is null or i.user_id = ${userId}))::int as attempted,
      (select count(*) from interactions i
        where i.connection = 'Connected' and i.occurred_at between ${start} and ${end}
          and (${userId}::text is null or i.user_id = ${userId}))::int as connected,
      (select count(*) from interactions i
        where i.connection in ('Missed','Not reachable')
          and i.occurred_at between ${start} and ${end}
          and (${userId}::text is null or i.user_id = ${userId}))::int as missed,
      (select count(*) from orders o
        where o.placed_at between ${start} and ${end}
          and (${userId}::text is null or o.user_id = ${userId}))::int as orders,
      (select coalesce(sum(o.value), 0) from orders o
        where o.placed_at between ${start} and ${end}
          and (${userId}::text is null or o.user_id = ${userId})) as order_value,
      (select coalesce(sum(p.amount), 0) from payments p
        where p.received_on = ${day}::date
          and (${userId}::text is null or p.recorded_by_id = ${userId})) as collected,
      (select count(*) from reminders r
        where r.created_at between ${start} and ${end}
          and (${userId}::text is null or r.user_id = ${userId}))::int as reminders_set,
      (select count(*) from reminders r
        where r.completed_at between ${start} and ${end}
          and (${userId}::text is null or r.user_id = ${userId}))::int as reminders_closed,
      (select count(*) from complaints c
        where c.logged_on = ${day}::date
          and (${userId}::text is null or c.logged_by_id = ${userId}))::int as complaints_logged,
      (select count(*) from wa_messages m
        where m.created_at between ${start} and ${end}
          and m.status in ('Sent','Delivered','Read')
          and (${userId}::text is null or m.sent_by_id = ${userId}))::int as messages_sent,
      (select count(*) from queue_items q
        where q.day = ${day}::date
          and (${userId}::text is null or q.owner_id = ${userId}))::int as queue_total,
      (select count(*) from queue_items q
        where q.day = ${day}::date and q.worked
          and (${userId}::text is null or q.owner_id = ${userId}))::int as queue_worked
  `);

  const attempted = row?.attempted ?? 0;
  const connected = row?.connected ?? 0;

  return {
    attempted,
    connected,
    missed: row?.missed ?? 0,
    connectRate: pct(connected, attempted),
    orders: row?.orders ?? 0,
    orderValue: Number(row?.order_value ?? 0),
    collected: Number(row?.collected ?? 0),
    remindersSet: row?.reminders_set ?? 0,
    remindersClosed: row?.reminders_closed ?? 0,
    complaintsLogged: row?.complaints_logged ?? 0,
    messagesSent: row?.messages_sent ?? 0,
    queueWorked: row?.queue_worked ?? 0,
    queueTotal: row?.queue_total ?? 0,
  };
}

export type TeamMemberDay = {
  user: User;
  activity: DayActivity;
  overdueReminders: number;
  targetPercent: number;
};

/**
 * The whole team's day in two round trips, grouped in the database. Calling
 * dayActivity() per person meant seven queries each — fifty round trips to
 * render one table.
 */
export async function teamDay(day = today()): Promise<TeamMemberDay[]> {
  const team = await listTeam();
  if (!team.length) return [];

  const ids = team.map((u) => u.id);
  const start = `${day}T00:00:00+05:30`;
  const end = `${day}T23:59:59.999+05:30`;
  const period = day.slice(0, 7);
  const monthStart = `${period}-01`;

  const rows = await db.execute<{
    user_id: string;
    attempted: number;
    connected: number;
    missed: number;
    orders: number;
    order_value: string;
    collected: string;
    reminders_set: number;
    reminders_closed: number;
    complaints_logged: number;
    messages_sent: number;
    queue_total: number;
    queue_worked: number;
    overdue_reminders: number;
    target_total: string;
    target_achieved: string;
  }>(sql`
    select u.id as user_id,
      (select count(*) from interactions i where i.user_id = u.id
        and i.channel = 'Call' and i.occurred_at between ${start} and ${end})::int as attempted,
      (select count(*) from interactions i where i.user_id = u.id
        and i.connection = 'Connected' and i.occurred_at between ${start} and ${end})::int as connected,
      (select count(*) from interactions i where i.user_id = u.id
        and i.connection in ('Missed','Not reachable')
        and i.occurred_at between ${start} and ${end})::int as missed,
      (select count(*) from orders o where o.user_id = u.id
        and o.placed_at between ${start} and ${end})::int as orders,
      (select coalesce(sum(o.value),0) from orders o where o.user_id = u.id
        and o.placed_at between ${start} and ${end}) as order_value,
      (select coalesce(sum(p.amount),0) from payments p where p.recorded_by_id = u.id
        and p.received_on = ${day}::date) as collected,
      (select count(*) from reminders r where r.user_id = u.id
        and r.created_at between ${start} and ${end})::int as reminders_set,
      (select count(*) from reminders r where r.user_id = u.id
        and r.completed_at between ${start} and ${end})::int as reminders_closed,
      (select count(*) from complaints c where c.logged_by_id = u.id
        and c.logged_on = ${day}::date)::int as complaints_logged,
      (select count(*) from wa_messages m where m.sent_by_id = u.id
        and m.created_at between ${start} and ${end}
        and m.status in ('Sent','Delivered','Read'))::int as messages_sent,
      (select count(*) from queue_items q where q.owner_id = u.id
        and q.day = ${day}::date)::int as queue_total,
      (select count(*) from queue_items q where q.owner_id = u.id
        and q.day = ${day}::date and q.worked)::int as queue_worked,
      (select count(*) from reminders r where r.user_id = u.id
        and r.status = 'open' and r.due_date < ${day}::date)::int as overdue_reminders,
      (select coalesce(sum(t.amount),0) from targets t
        join customers c2 on c2.id = t.customer_id
        where c2.owner_id = u.id and t.period = ${period}) as target_total,
      (select coalesce(sum(o.value),0) from orders o
        join customers c3 on c3.id = o.customer_id
        where c3.owner_id = u.id
          and o.placed_at >= ${monthStart}::date
          and o.placed_at < (${monthStart}::date + interval '1 month')) as target_achieved
    from users u
    -- sql.param keeps this one array parameter; interpolating the array
    -- directly makes Drizzle expand it into a tuple, which any() rejects.
    where u.id = any(${sql.param(ids)}::text[])
  `);

  const byUser = new Map(rows.map((r) => [r.user_id, r]));

  return team.map((user) => {
    const r = byUser.get(user.id);
    const attempted = r?.attempted ?? 0;
    const connected = r?.connected ?? 0;
    return {
      user,
      activity: {
        attempted,
        connected,
        missed: r?.missed ?? 0,
        connectRate: pct(connected, attempted),
        orders: r?.orders ?? 0,
        orderValue: Number(r?.order_value ?? 0),
        collected: Number(r?.collected ?? 0),
        remindersSet: r?.reminders_set ?? 0,
        remindersClosed: r?.reminders_closed ?? 0,
        complaintsLogged: r?.complaints_logged ?? 0,
        messagesSent: r?.messages_sent ?? 0,
        queueWorked: r?.queue_worked ?? 0,
        queueTotal: r?.queue_total ?? 0,
      },
      overdueReminders: r?.overdue_reminders ?? 0,
      targetPercent: pct(Number(r?.target_achieved ?? 0), Number(r?.target_total ?? 0)),
    };
  });
}

/* --------------------------------------------------------------- whatsapp */

export async function listTemplates(includeArchived = false) {
  return db
    .select()
    .from(waTemplates)
    .where(includeArchived ? undefined : eq(waTemplates.archived, false))
    .orderBy(asc(waTemplates.category), asc(waTemplates.name));
}

export async function listMessages(user: User, scope: Scope, limit = 300) {
  const owner = ownerFilter(user, scope);
  const rows = await db
    .select({
      message: waMessages,
      customerName: customers.name,
      sentByName: users.name,
    })
    .from(waMessages)
    .innerJoin(customers, eq(customers.id, waMessages.customerId))
    .innerJoin(users, eq(users.id, waMessages.sentById))
    .where(owner ? eq(waMessages.sentById, owner) : undefined)
    .orderBy(desc(waMessages.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    ...r.message,
    customerName: r.customerName,
    sentByName: r.sentByName,
  }));
}

export async function listReplies(user: User, scope: Scope) {
  const owner = ownerFilter(user, scope);
  const rows = await db
    .select({ reply: waReplies, customerName: customers.name })
    .from(waReplies)
    .innerJoin(customers, eq(customers.id, waReplies.customerId))
    .where(
      and(
        eq(waReplies.actioned, false),
        owner ? eq(customers.ownerId, owner) : undefined,
      ),
    )
    .orderBy(desc(waReplies.receivedAt));

  return rows.map((r) => ({ ...r.reply, customerName: r.customerName }));
}

export async function getActiveRun(userId: string) {
  const rows = await db
    .select()
    .from(waRuns)
    .where(and(eq(waRuns.userId, userId), isNull(waRuns.finishedAt)))
    .orderBy(desc(waRuns.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getLastFinishedRun(userId: string) {
  const rows = await db
    .select()
    .from(waRuns)
    .where(and(eq(waRuns.userId, userId), sql`${waRuns.finishedAt} is not null`))
    .orderBy(desc(waRuns.finishedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getWaMode(): Promise<"manual" | "connected" | "failing"> {
  const row = await db.query.settings.findFirst({
    where: (s, { eq }) => eq(s.key, "whatsapp_mode"),
  });
  const value = (row?.value as { mode?: string } | undefined)?.mode;
  return value === "connected" || value === "failing" ? value : "manual";
}

/* ---------------------------------------------------------- notifications */

export async function listNotifications(userId: string) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(30);
}

/* ------------------------------------------------------------------- help */

export async function listHelpArticles() {
  return db
    .select()
    .from(helpArticles)
    .orderBy(asc(helpArticles.category), asc(helpArticles.title));
}

/* -------------------------------------------------------------------- EOD */

export async function getEodReport(userId: string, day = today()) {
  const rows = await db
    .select()
    .from(eodReports)
    .where(and(eq(eodReports.userId, userId), eq(eodReports.day, day)))
    .limit(1);
  return rows[0] ?? null;
}

/** Reminders due today that are still open — these gate the EOD submission. */
export async function openRemindersDue(userId: string, day = today()) {
  const rows = await db
    .select({ reminder: reminders, customerName: customers.name })
    .from(reminders)
    .innerJoin(customers, eq(customers.id, reminders.customerId))
    .where(
      and(
        eq(reminders.userId, userId),
        eq(reminders.status, "open"),
        lte(reminders.dueDate, day),
      ),
    )
    .orderBy(asc(reminders.dueDate));

  return rows.map((r) => ({
    id: r.reminder.id,
    note: r.reminder.note,
    dueDate: r.reminder.dueDate,
    customerName: r.customerName,
    overdueDays: Math.max(0, daysBetween(r.reminder.dueDate, day)),
  }));
}

/* --------------------------------------------------------------- search */

export async function globalSearch(user: User, scope: Scope, q: string) {
  const term = q.trim();
  if (term.length < 2) return { customers: [], bills: [] };

  const owner = ownerFilter(user, scope);
  const like = `%${term}%`;

  const [cust, bill] = await Promise.all([
    db
      .select({
        id: customers.id,
        name: customers.name,
        city: customers.city,
        phone: customers.phone,
      })
      .from(customers)
      .where(
        and(
          or(
            sql`${customers.name} ilike ${like}`,
            sql`${customers.contactPerson} ilike ${like}`,
            sql`${customers.phone} ilike ${like}`,
          ),
          owner ? eq(customers.ownerId, owner) : undefined,
        ),
      )
      .limit(5),
    db
      .select({
        id: bills.id,
        billNo: bills.billNo,
        amount: bills.amount,
        customerId: bills.customerId,
        customerName: customers.name,
      })
      .from(bills)
      .innerJoin(customers, eq(customers.id, bills.customerId))
      .where(
        and(
          sql`${bills.billNo} ilike ${like}`,
          owner ? eq(customers.ownerId, owner) : undefined,
        ),
      )
      .limit(5),
  ]);

  return { customers: cust, bills: bill };
}
