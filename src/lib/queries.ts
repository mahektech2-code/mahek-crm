import "server-only";
import { and, asc, desc, eq, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  bills,
  calls,
  complaints,
  customers,
  helpArticles,
  notifications,
  orders,
  users,
} from "@/db/schema";
import { ASSIGNED_TO_SQL, resolveScope, scopedUserIds } from "./access-control";
import { today as businessToday } from "./recompute";
import { daysBetween, monthKey } from "./business-date";
import { eodMetricsFor } from "./services/eod-service";

/* ---------------------------------------------------------------------------
 * Reads for the screens. Every one resolves scope, so a missed check cannot
 * leak another telecaller's book.
 * ------------------------------------------------------------------------- */

export const today = businessToday;

export async function currentPeriod(): Promise<string> {
  return monthKey(await businessToday());
}

export async function listTeam() {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  return db
    .select()
    .from(users)
    .where(
      and(eq(users.active, true), ids ? inArray(users.id, ids) : undefined),
    )
    .orderBy(asc(users.name));
}

/* ------------------------------------------------------------- customers */

export type CustomerRow = typeof customers.$inferSelect & {
  ownerName: string | null;
  salesAmName: string | null;
  backOfficeAmName: string | null;
  openComplaints: number;
};

/**
 * The customer status label, in SQL.
 *
 * The same rule as `customerStatusLabel` in lib/format.ts, which is the
 * definition — this exists only because the list is now filtered and counted
 * in Postgres, and a filter cannot call a TypeScript function. Two statements
 * of one rule is a drift risk, so an integration test asserts they agree for
 * every combination rather than trusting that they do.
 *
 * Order matters and matches the original: deactivated, then inactive (which
 * outranks slow payer, because it is the one that says stop and think), then
 * never-ordered, then slow payer.
 */
const STATUS_LABEL_SQL = sql<string>`
  case
    when customers.status = 'deactivated' then 'Deactivated'
    when customers.status = 'inactive'    then 'Inactive'
    when customers.last_order_date is null then 'New'
    when customers.slow_payer             then 'Slow payer'
    else 'Active'
  end
`;

export type CustomerListFilters = {
  query?: string;
  /** A label from customerStatusLabel, or absent for all of them. */
  status?: string;
  /** An owner's name as shown in the filter, or absent for all. */
  owner?: string;
  page?: number;
  perPage?: number;
};

export type CustomerListPage = {
  rows: CustomerRow[];
  /** Matching the filters. */
  total: number;
  /** In the whole book, before any filter. */
  bookTotal: number;
  page: number;
  pageCount: number;
  /** Over the FILTERED set, not the page — the tiles describe the search. */
  totals: { outstanding: number; slowPayers: number; withComplaints: number };
};

/**
 * One page of the customer list, filtered and counted in the database.
 *
 * The screen used to receive every row and do this in the browser. That was
 * honest at fifty-two records and stopped being so at eleven hundred: the page
 * carried the entire book over the wire to show twenty-five of it, and the
 * totals above the table were summed on the client from data it had all been
 * sent anyway.
 */
export async function listCustomersPage(
  filters: CustomerListFilters = {},
): Promise<CustomerListPage> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const perPage = Math.min(Math.max(filters.perPage ?? 25, 1), 200);

  const scoped = ids ? inArray(ASSIGNED_TO_SQL, ids) : undefined;

  const where: SQL[] = [];
  if (scoped) where.push(scoped);

  const q = filters.query?.trim();
  if (q) {
    const like = `%${q}%`;
    where.push(sql`(
      customers.name ilike ${like}
      or customers.contact_person ilike ${like}
      or customers.phone like ${like}
      or customers.city ilike ${like}
    )`);
  }
  if (filters.status) where.push(sql`${STATUS_LABEL_SQL} = ${filters.status}`);
  if (filters.owner) {
    where.push(sql`(select name from users u where u.id = customers.owner_id) = ${filters.owner}`);
  }

  const clause = where.length ? and(...where) : undefined;

  // One pass for the count and the tiles. Summing these in the browser meant
  // sending every row to add them up.
  const [agg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      outstanding: sql<number>`coalesce(sum(${customers.outstanding}), 0)::bigint`,
      slowPayers: sql<number>`count(*) filter (where ${customers.slowPayer})::int`,
      withComplaints: sql<number>`count(*) filter (where (
        select count(*) from ${complaints}
         where complaints.customer_id = customers.id
           and ${complaints.status} in ('open','in_progress','awaiting_customer')
      ) > 0)::int`,
    })
    .from(customers)
    .where(clause);

  const [book] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(customers)
    .where(scoped);

  const total = Number(agg?.total ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(filters.page ?? 1, 1), pageCount);

  const rows = await db
    .select({
      customer: customers,
      ownerName: users.name,
      salesAmName: sql<string | null>`(
        select name from users u where u.id = customers.sales_am_id
      )`,
      backOfficeAmName: sql<string | null>`(
        select name from users u where u.id = customers.back_office_am_id
      )`,
      openComplaints: sql<number>`(
        select count(*)::int from ${complaints}
         where complaints.customer_id = customers.id
           and ${complaints.status} in ('open','in_progress','awaiting_customer')
      )`,
    })
    .from(customers)
    .leftJoin(users, eq(users.id, customers.ownerId))
    .where(clause)
    .orderBy(asc(customers.name))
    .limit(perPage)
    .offset((page - 1) * perPage);

  return {
    rows: rows.map((r) => ({
      ...r.customer,
      ownerName: r.ownerName,
      salesAmName: r.salesAmName,
      backOfficeAmName: r.backOfficeAmName,
      openComplaints: Number(r.openComplaints),
    })),
    total,
    bookTotal: Number(book?.n ?? 0),
    page,
    pageCount,
    totals: {
      outstanding: Number(agg?.outstanding ?? 0),
      slowPayers: Number(agg?.slowPayers ?? 0),
      withComplaints: Number(agg?.withComplaints ?? 0),
    },
  };
}

export async function listCustomers(): Promise<CustomerRow[]> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);

  const rows = await db
    .select({
      customer: customers,
      ownerName: users.name,
      // Subqueries rather than two more joins: three left joins to the same
      // table on one row is where column aliasing starts going wrong quietly.
      salesAmName: sql<string | null>`(
        select name from users u where u.id = customers.sales_am_id
      )`,
      backOfficeAmName: sql<string | null>`(
        select name from users u where u.id = customers.back_office_am_id
      )`,
      openComplaints: sql<number>`(
        select count(*)::int from ${complaints}
         where complaints.customer_id = customers.id
           and ${complaints.status} in ('open','in_progress','awaiting_customer')
      )`,
    })
    .from(customers)
    .leftJoin(users, eq(users.id, customers.ownerId))
    .where(ids ? inArray(ASSIGNED_TO_SQL, ids) : undefined)
    .orderBy(asc(customers.name));

  return rows.map((r) => ({
    ...r.customer,
    ownerName: r.ownerName,
    salesAmName: r.salesAmName,
    backOfficeAmName: r.backOfficeAmName,
    openComplaints: Number(r.openComplaints),
  }));
}

export async function getCustomer(customerId: string) {
  const rows = await db
    .select({
      customer: customers,
      ownerName: users.name,
      salesAmName: sql<string | null>`(
        select name from users u where u.id = customers.sales_am_id
      )`,
      backOfficeAmName: sql<string | null>`(
        select name from users u where u.id = customers.back_office_am_id
      )`,
    })
    .from(customers)
    .leftJoin(users, eq(users.id, customers.ownerId))
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!rows[0]) return null;
  return {
    ...rows[0].customer,
    ownerName: rows[0].ownerName,
    salesAmName: rows[0].salesAmName,
    backOfficeAmName: rows[0].backOfficeAmName,
  };
}

/* -------------------------------------------------------------- timeline */

export type TimelineEntry = {
  id: string;
  kind:
    | "Call"
    | "WhatsApp"
    | "Order"
    | "Reminder"
    | "Complaint"
    | "Payment"
    | "Bill";
  at: Date;
  actor: string;
  content: string;
  meta?: string;
};

/** The unified customer timeline, in one round trip. */
export async function customerTimeline(
  customerId: string,
): Promise<TimelineEntry[]> {
  const rows = await db.execute<{
    id: string;
    kind: TimelineEntry["kind"];
    at: Date;
    actor: string;
    content: string;
    meta: string | null;
  }>(sql`
    select c.id, 'Call' as kind, c.started_at as at, u.name as actor,
           coalesce(c.notes, c.outcome::text, 'Call logged') as content,
           nullif(concat_ws(' · ', c.connection_status, c.outcome), '') as meta
      from calls c join users u on u.id = c.user_id
     where c.customer_id = ${customerId}
    union all
    select m.id, 'WhatsApp', coalesce(m.confirmed_sent_at, m.sent_at, m.prepared_at),
           u.name, coalesce(m.template_name, 'WhatsApp message'),
           concat_ws(' · ', m.resolved_destination, m.status)
      from wa_messages m join users u on u.id = m.user_id
     where m.customer_id = ${customerId}
    union all
    select o.id, 'Order', o.ordered_at, coalesce(u.name, 'Order system'),
           case o.status
             when 'pending_approval' then 'Order waiting for approval'
             when 'declined' then 'Order declined'
             else concat('Order ', o.status)
           end,
           -- A declined order says why on the timeline. The telecaller has to
           -- ring the customer back, and hunting for the reason is how that
           -- call gets made badly or not at all.
           concat_ws(' · ',
             concat('₹', to_char(round(o.total_amount / 100.0), 'FM9G99G99G999')),
             o.decline_reason)
      from orders o left join users u on u.id = o.user_id
     where o.customer_id = ${customerId}
    union all
    select r.id, 'Reminder', r.created_at, u.name, r.note,
           concat('Due ', to_char(r.due_date, 'DD Mon'), ' · ', r.status)
      from reminders r join users u on u.id = r.assigned_user_id
     where r.customer_id = ${customerId}
    union all
    select cm.id, 'Complaint', cm.created_at, u.name, cm.description,
           concat(cm.category, ' · ', cm.status)
      from complaints cm join users u on u.id = cm.logged_by_user_id
     where cm.customer_id = ${customerId}
    union all
    -- Receipts, not allocation lines: one arrival of money is one entry,
    -- however many bills it was spread across. A reported receipt appears the
    -- moment it is reported and says it is waiting, and a rejected one STAYS —
    -- a transfer that never landed is a fact about the account, and dropping
    -- it leaves the next person wondering why the balance never moved.
    select pr.id, 'Payment', pr.received_at::timestamptz,
           coalesce(u.name, 'Accounts'),
           case pr.status
             when 'reported' then concat('Payment of ₹', to_char(round(pr.amount / 100.0), 'FM9G99G99G999'), ' reported')
             when 'rejected' then concat('Payment of ₹', to_char(round(pr.amount / 100.0), 'FM9G99G99G999'), ' could not be found')
             else concat('Payment received ₹', to_char(round(pr.amount / 100.0), 'FM9G99G99G999'))
           end,
           concat_ws(' · ', pr.mode, pr.reference,
             case pr.status
               when 'reported' then 'waiting for accounts to confirm'
               when 'rejected' then pr.reject_reason
             end)
      from payment_receipts pr left join users u on u.id = pr.reported_by_id
     where pr.customer_id = ${customerId}
    union all
    select b.id, 'Bill', b.bill_date::timestamptz, 'Accounts',
           concat('Bill ', b.bill_no, ' raised'),
           concat('₹', to_char(round(b.amount / 100.0), 'FM9G99G99G999'))
      from bills b where b.customer_id = ${customerId}
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

/* ------------------------------------------------------- credit note asks */

export type PendingCreditNote = {
  complaintId: string;
  customerId: string;
  customerName: string;
  category: string;
  amount: number | null;
  billNo: string | null;
  raisedAt: Date;
  raisedByName: string | null;
  ageDays: number;
};

/**
 * §6.2 — credit notes asked for and not yet answered.
 *
 * There is no Accounts app and no defined recipient, so a request has nowhere
 * to go. Rather than let it sit invisible on a complaint, it is surfaced as a
 * list a manager can work. This is deliberately interim: a credit note has
 * financial consequences and cannot stay unrouted indefinitely.
 */
export async function pendingCreditNotes(): Promise<PendingCreditNote[]> {
  const rows = await db.execute<{
    complaint_id: string;
    customer_id: string;
    customer_name: string;
    category: string;
    amount: number | null;
    bill_no: string | null;
    raised_at: Date;
    raised_by: string | null;
    age_days: number;
  }>(sql`
    select cm.id as complaint_id, cm.customer_id, c.name as customer_name,
           cm.category::text as category, cm.cn_amount as amount,
           b.bill_no, cm.created_at as raised_at, u.name as raised_by,
           extract(day from now() - cm.created_at)::int as age_days
      from complaints cm
      join customers c on c.id = cm.customer_id
      left join bills b on b.id = cm.bill_id
      left join users u on u.id = cm.logged_by_user_id
     where cm.request_cn = true
       and coalesce(cm.cn_status, 'requested') in ('requested', 'under_review')
     order by cm.created_at asc
  `);

  return rows.map((r) => ({
    complaintId: r.complaint_id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    category: r.category,
    amount: r.amount === null ? null : Number(r.amount),
    billNo: r.bill_no,
    raisedAt: new Date(r.raised_at),
    raisedByName: r.raised_by,
    ageDays: Number(r.age_days),
  }));
}

/* -------------------------------------------------------- message history */

export type CustomerMessage = {
  id: string;
  at: Date;
  by: string;
  status: string;
  /** Which route it took — the manual copy-paste path, or the API. */
  channelLabel: string;
  /** The number or group name it actually went to. */
  destination: string;
  destKind: "personal" | "group";
  templateName: string | null;
  /** Empty for older rows that recorded a template but no body. */
  body: string;
  edited: boolean;
};

/**
 * Every message ever prepared for one customer, newest first. The timeline
 * carries a one-line summary of each; this is the full text, because a
 * telecaller asked what we actually said needs to read it, not infer it.
 */
export async function customerMessages(
  customerId: string,
): Promise<CustomerMessage[]> {
  const rows = await db.execute<{
    id: string;
    at: Date;
    by: string;
    status: string;
    mode: string;
    destination: string;
    dest_kind: "personal" | "group";
    template_name: string | null;
    body: string;
    edited: boolean;
  }>(sql`
    select m.id,
           coalesce(m.confirmed_sent_at, m.sent_at, m.copied_at, m.prepared_at) as at,
           u.name as by, m.status::text as status, m.mode::text as mode,
           m.resolved_destination as destination, m.dest_kind::text as dest_kind,
           m.template_name, m.body, m.edited
      from wa_messages m join users u on u.id = m.user_id
     where m.customer_id = ${customerId}
     order by at desc
  `);

  return rows.map((r) => ({
    id: r.id,
    at: new Date(r.at),
    by: r.by,
    status: r.status,
    channelLabel: r.mode === "automatic" ? "Sent by API" : "Sent by hand",
    destination: r.destination,
    destKind: r.dest_kind,
    templateName: r.template_name,
    body: r.body ?? "",
    edited: r.edited,
  }));
}

/* ------------------------------------------------------------ interactions */

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
  sourceModule: string | null;
};

export async function listInteractions(limit = 400): Promise<InteractionRow[]> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);

  const rows = await db
    .select({ call: calls, customerName: customers.name, userName: users.name })
    .from(calls)
    .innerJoin(customers, eq(customers.id, calls.customerId))
    .innerJoin(users, eq(users.id, calls.userId))
    .where(ids ? inArray(calls.userId, ids) : undefined)
    .orderBy(desc(calls.startedAt))
    .limit(limit);

  return rows.map(({ call: c, customerName, userName }) => ({
    id: c.id,
    occurredAt: c.startedAt,
    customerId: c.customerId,
    customerName,
    userName,
    channel: "Call",
    connection: c.connectionStatus,
    outcome: c.outcome,
    note: c.notes,
    produced:
      [
        c.orderId && "Order",
        c.reminderId && "Reminder",
        c.complaintId && "Complaint",
      ]
        .filter(Boolean)
        .join(" · ") || null,
    sourceModule: c.sourceModule,
  }));
}

/* ------------------------------------------------------------ day activity */

export type DayActivity = Awaited<ReturnType<typeof eodMetricsFor>> & {
  connectRate: number;
};

const ZERO_METRICS = () => ({
  callsAttempted: 0,
  callsConnected: 0,
  callsInbound: 0,
  callsMissed: 0,
  ordersWithoutCall: 0,
  queueWorked: 0,
  ordersCaptured: 0,
  ordersCount: 0,
  ordersValue: 0,
  followUpsMade: 0,
  promisesCount: 0,
  promisesValue: 0,
  paymentsConfirmed: 0,
  remindersClosed: 0,
  remindersCreated: 0,
  remindersCarriedForward: 0,
  complaintsLogged: 0,
  whatsappSent: 0,
  targetAchieved: 0,
  targetAmount: 0,
});

export async function dayActivity(
  userId: string | null,
  day?: string,
): Promise<DayActivity> {
  const target = day ?? (await businessToday());

  const metrics = userId
    ? await eodMetricsFor(userId, target)
    : (
        await Promise.all(
          (await listTeam()).map((u) => eodMetricsFor(u.id, target)),
        )
      ).reduce((acc, m) => {
        for (const k of Object.keys(acc) as Array<keyof typeof acc>)
          acc[k] += m[k];
        return acc;
      }, ZERO_METRICS());

  return {
    ...metrics,
    connectRate: metrics.callsAttempted
      ? Math.round((metrics.callsConnected / metrics.callsAttempted) * 100)
      : 0,
  };
}

export type TeamMemberDay = {
  user: typeof users.$inferSelect;
  activity: DayActivity;
  overdueReminders: number;
  targetPercent: number;
};

export async function teamDay(day?: string): Promise<TeamMemberDay[]> {
  const target = day ?? (await businessToday());
  const team = await listTeam();

  return Promise.all(
    team.map(async (user) => {
      const m = await eodMetricsFor(user.id, target);
      const [row] = await db.execute<{ overdue: number }>(sql`
        select count(*)::int as overdue from reminders r
         where r.assigned_user_id = ${user.id} and r.status = 'pending'
           and r.due_date < ${target}::date
      `);
      return {
        user,
        activity: {
          ...m,
          connectRate: m.callsAttempted
            ? Math.round((m.callsConnected / m.callsAttempted) * 100)
            : 0,
        },
        overdueReminders: Number(row?.overdue ?? 0),
        targetPercent: m.targetAmount
          ? Math.round((m.targetAchieved / m.targetAmount) * 100)
          : 0,
      };
    }),
  );
}

/* ----------------------------------------------------------- notifications */

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
  const ctx = await resolveScope();
  const rows = await db
    .select()
    .from(helpArticles)
    .where(eq(helpArticles.active, true))
    .orderBy(asc(helpArticles.category), asc(helpArticles.title));
  // Filtered to the caller's role.
  return rows.filter(
    (a) => a.roles.includes(ctx.role) || a.roles.includes("all"),
  );
}

/* ---------------------------------------------------------------- search */

export async function globalSearch(q: string) {
  const term = q.trim();
  if (term.length < 2) return { customers: [], bills: [], products: [] };

  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const like = `%${term}%`;
  const digits = term.replace(/\D/g, "");

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
            digits.length >= 4
              ? sql`${customers.phone} like ${"%" + digits + "%"}`
              : undefined,
          ),
          ids ? inArray(ASSIGNED_TO_SQL, ids) : undefined,
        ),
      )
      .limit(8),
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
          ids ? inArray(ASSIGNED_TO_SQL, ids) : undefined,
        ),
      )
      .limit(5),
  ]);

  /**
   * Products are searched too, and unlike customers and bills they are not
   * scoped: the catalogue is the same catalogue for everybody, and a
   * telecaller asking "do we sell M5x4 in 20 litre" is asking about the
   * business, not about their own book.
   *
   * The same matching the order form uses — formulation, brand and alias as
   * well as the name — so a product found here and a product found there are
   * never two different answers to one question.
   */
  const product = await db.execute<{
    id: string;
    name: string;
    formulation: string | null;
    packing: string | null;
  }>(sql`
    select p.id, p.name, f.name as formulation, p.packing
      from products p
      left join product_formulations f on f.id = p.formulation_id
      left join product_brands b on b.id = p.brand_id
     where p.active = true
       and (
         p.name ilike ${like}
         or coalesce(f.name, '') ilike ${like}
         or coalesce(b.name, '') ilike ${like}
         or exists (
              select 1 from product_aliases a
               where a.product_id = p.id and a.name ilike ${like}
            )
       )
     order by
       case when p.name ilike ${term + "%"} then 0
            when p.name ilike ${like} then 1
            else 2 end,
       p.display_order, p.name
     limit 5
  `);

  return {
    customers: cust,
    bills: bill,
    products: product.map((p) => ({
      id: p.id,
      name: p.name,
      subtitle: [p.formulation, p.packing].filter(Boolean).join(" · "),
    })),
  };
}

export { daysBetween, lte, orders, calls };
