import "server-only";
import { cache } from "react";
import { and, asc, desc, eq, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  bills,
  calls,
  complaints,
  customerAmChanges,
  customers,
  employees,
  helpArticles,
  notifications,
  orders,
  users,
} from "@/db/schema";
import { ASSIGNED_TO_SQL, resolveScope, scopedUserIds, scopedToUsers} from "./access-control";
import { isManager, requireUser } from "./auth";
import { getScope } from "./scope";
import { today as businessToday } from "./recompute";
import { daysBetween, monthKey, type DateRange } from "./business-date";
import { eodMetricsFor, eodMetricsForRange } from "./services/eod-service";

/* ---------------------------------------------------------------------------
 * Reads for the screens. Every one resolves scope, so a missed check cannot
 * leak another telecaller's book.
 * ------------------------------------------------------------------------- */

export const today = businessToday;

export async function currentPeriod(): Promise<string> {
  return monthKey(await businessToday());
}

/**
 * Reminders due today and complaints still open — the pair behind the sidebar
 * badges, the CRM launcher tile and the top of the dashboard.
 *
 * It was written out three times, and the three had already drifted. The
 * sidebar honoured the My book / Team switch (`scope === "team" && isManager`)
 * and the launcher did not (`isManager` alone) — so a manager who had chosen
 * My book read their own reminders in the sidebar and the whole team's on the
 * tile it sits beside, with nothing on either saying which was which. That is
 * the drift the one-function rule exists to stop, and it is why this is a
 * function rather than three careful copies.
 *
 * The switch wins, because it is a thing somebody set on purpose.
 *
 * Request-memoised: the launcher and the CRM layout both ask, and on `/apps`
 * inside one render that would otherwise be the same pair of counts twice.
 */
export const crmBadgeCounts = cache(async function crmBadgeCounts(): Promise<{
  dueReminders: number;
  openComplaints: number;
}> {
  const user = await requireUser();
  const scope = await getScope(user);
  const teamWide = scope === "team" && isManager(user);
  const day = await businessToday();

  const [row] = await db.execute<{ reminders: number; complaints: number }>(sql`
    select
      (select count(*) from reminders r
        where r.status = 'pending' and r.due_date <= ${day}::date
          and (${teamWide} or r.assigned_user_id = ${user.id}))::int as reminders,
      (select count(*) from complaints c
        join customers cu on cu.id = c.customer_id
        where c.status in ('open','in_progress','awaiting_customer')
          and (${teamWide} or cu.owner_id = ${user.id}))::int as complaints
  `);

  return {
    dueReminders: row?.reminders ?? 0,
    openComplaints: row?.complaints ?? 0,
  };
});

/* ------------------------------------------ deactivation and reactivation */

export type CustomerStatusRequest = {
  customerId: string;
  customerName: string;
  /** `deactivate` — please close this account. `reactivate` — please reopen it. */
  kind: "deactivate" | "reactivate";
  reason: string | null;
  /** Null on requests raised before the asker was recorded. Say so; do not guess. */
  askedBy: string | null;
  /**
   * The IST calendar date the request was raised on, computed by Postgres.
   *
   * NOT an instant for the screen to truncate. Returning a full ISO timestamp
   * and slicing the first ten characters off it in the component would be the
   * §11 bug in two halves — `toISOString()` answers in UTC, so a request raised
   * at 21:00 UTC is the NEXT day in Asia/Kolkata and would display a day early.
   * Split across two files, the grep that guards this cannot see it.
   */
  askedOn: string | null;
  /** Whose book it is, so a manager knows who to ring about it. */
  assignedTo: string | null;
  status: string;
  outstanding: number;
  lastOrderDate: string | null;
};

/**
 * EVERY UNANSWERED REQUEST, both directions, oldest first.
 *
 * NOT SCOPED. A request is work for whoever decides it, not for whoever raised
 * it — scoping this to a manager's own book would hide requests raised by
 * telecallers whose customers sit in somebody else's, which is most of them.
 * The route already refuses anybody without `customer.deactivate`.
 *
 * Oldest first because the oldest ask is the one somebody has been waiting on,
 * and because six of these have been waiting since before there was a screen to
 * answer them from.
 *
 * `outstanding` and `lastOrderDate` ride along because they are the two facts
 * that change the answer: closing an account that still owes money is a
 * different decision from closing one that is square, and a customer who
 * ordered last week is not finished whatever the request says.
 */
export async function listCustomerStatusRequests(): Promise<CustomerStatusRequest[]> {
  const rows = await db.execute<{
    customer_id: string;
    customer_name: string;
    kind: "deactivate" | "reactivate";
    reason: string | null;
    asked_by: string | null;
    asked_on: string | null;
    assigned_to: string | null;
    status: string;
    outstanding: number;
    last_order_date: string | null;
  }>(sql`
    -- NOT ALIASED. ASSIGNED_TO_SQL is written against the customers table by
    -- name, so aliasing it here would leave that fragment referencing a table
    -- which is not in scope — the same class of mistake as the bare-column one
    -- the section 11 tests guard, in the other direction.
    select customers.id                as customer_id,
           customers.name              as customer_name,
           'deactivate'                as kind,
           customers.deactivation_reason as reason,
           u.name                      as asked_by,
           (customers.deactivation_requested_at at time zone 'Asia/Kolkata')::date as asked_on,
           a.name                      as assigned_to,
           customers.status            as status,
           coalesce(customers.outstanding, 0)::bigint as outstanding,
           customers.last_order_date   as last_order_date
      from customers
      left join users u on u.id = customers.deactivation_requested_by_id
      left join users a on a.id = ${ASSIGNED_TO_SQL}
     where customers.deactivation_requested
    union all
    select customers.id, customers.name, 'reactivate',
           customers.reactivation_reason,
           u.name, (customers.reactivation_requested_at at time zone 'Asia/Kolkata')::date,
           a.name, customers.status,
           coalesce(customers.outstanding, 0)::bigint,
           customers.last_order_date
      from customers
      left join users u on u.id = customers.reactivation_requested_by_id
      left join users a on a.id = ${ASSIGNED_TO_SQL}
     where customers.reactivation_requested
     -- Nulls last: a request with no recorded date is one of the old ones, and
     -- it belongs at the bottom rather than pretending to be the newest.
     order by asked_on asc nulls last, customer_name asc
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    customerId: String(r.customer_id),
    customerName: String(r.customer_name),
    kind: r.kind as "deactivate" | "reactivate",
    reason: (r.reason as string | null) ?? null,
    askedBy: (r.asked_by as string | null) ?? null,
    askedOn: (r.asked_on as string | null) ?? null,
    assignedTo: (r.assigned_to as string | null) ?? null,
    status: String(r.status),
    outstanding: Number(r.outstanding ?? 0),
    lastOrderDate: (r.last_order_date as string | null) ?? null,
  }));
}

/** How many requests are waiting. The sidebar badge and the screen agree. */
export async function customerStatusRequestCount(): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    select (count(*) filter (where deactivation_requested)
          + count(*) filter (where reactivation_requested))::int as n
      from customers
  `);
  return row?.n ?? 0;
}

/**
 * Memoised for the REQUEST, the way `resolveScope` and `getCurrentUser`
 * already are — not cached across requests, which for a scoped read would be
 * a way to serve one person another's book.
 *
 * A manager's dashboard asked for it three times in one render — twice through
 * `rangeActivity` (the period and the one before it) and once through
 * `teamRange` — and each answer then fanned out into one twenty-subquery EOD
 * query PER PERSON. The duplication was never in the loop; it was in the list
 * the loop is built from.
 */
export const listTeam = cache(async function listTeam() {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  return db
    .select()
    .from(users)
    .where(
      and(eq(users.active, true), ids ? inArray(users.id, ids) : undefined),
    )
    .orderBy(asc(users.name));
});

/**
 * Everybody who can HOLD a book, which is not the same question as whose book
 * the reader may see.
 *
 * `listTeam()` is scoped, and the reassignment picker was built from it — so
 * an admin looking at My book was offered exactly one person, themselves, and
 * a manager was offered their own reporting line. Whose account it becomes is
 * a fact about the staff list, not about the actor's view, and scoping it
 * turned a choice of ten into a choice of one with nothing saying why.
 *
 * Deliberately unscoped, and it is a list of NAMES AND ROLES — no customer
 * data, nothing a scope exists to protect. The capability check on the action
 * is what decides whether anybody may act on it.
 *
 * Inactive accounts are left out: giving a book to somebody who has left is
 * the thing reassignment exists to undo.
 */
export async function listAssignableUsers(): Promise<
  Array<{ id: string; name: string; role: string }>
> {
  return db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(eq(users.active, true))
    .orderBy(asc(users.name));
}

/**
 * Who may be the BACK OFFICE account manager: every account, plus every
 * CURRENT employee from the HRMS master.
 *
 * The two seats take different lists on purpose. Sales decides whose calling
 * queue an account lands in, so it can only be somebody who signs in — a name
 * with no account cannot be given work to do, and `ASSIGNED_TO_SQL` would
 * resolve it to nobody. Back office is dispatch, billing and paperwork: it
 * drives no queue and no scope, so the seventy-one people on the employee
 * sheet are as valid an answer as the ten who have logins, and refusing them
 * meant the real answer usually could not be recorded at all.
 *
 * An employee is returned with an `emp:` id, which is not a `users` id and is
 * never written to one — the action resolves it back to a name. `customers
 * .backOfficeName` already exists for exactly this: the sheet has always
 * named people who have no account.
 */
export async function listBackOfficeCandidates(): Promise<
  Array<{ id: string; name: string; role: string }>
> {
  const [accounts, staff] = await Promise.all([
    listAssignableUsers(),
    db
      .select({ id: employees.id, name: employees.name })
      .from(employees)
      /*
       * CURRENT employees, and only them. The master is a lifetime record —
       * 45 of its 71 rows are leavers, and a leaver is never a valid answer
       * to "who handles the paperwork on this account". They are kept in the
       * table rather than deleted, because payroll history outlives a
       * spreadsheet edit; they are simply not offered.
       *
       * `eq(active)` rather than `ne(inactive)`: `unknown` means the sheet did
       * not state a status, and an unstated one must not read as "still
       * here" on a list whose whole job is to name somebody who is.
       */
      .where(eq(employees.status, "active"))
      .orderBy(asc(employees.name)),
  ]);

  const takenNames = new Set(accounts.map((a) => a.name.trim().toLowerCase()));
  return [
    ...accounts,
    // Somebody with both an account and an employee row is ONE person, and the
    // account is the better half of them — it can be given a queue. Offering
    // both spellings would make the list a puzzle about which Sunita to pick.
    ...staff
      .filter((e) => !takenNames.has(e.name.trim().toLowerCase()))
      .map((e) => ({ id: `emp:${e.id}`, name: e.name, role: "employee" })),
  ];
}

/* ------------------------------------------------------------- customers */

export type CustomerRow = typeof customers.$inferSelect & {
  ownerName: string | null;
  salesAmName: string | null;
  backOfficeAmName: string | null;
  openComplaints: number;
  /**
   * Orders whose goods came here on somebody else's bill. This is the evidence
   * the marking decision rests on — a name is a guess, "received 14 deliveries"
   * is a fact — so it sits on the row rather than behind a filter.
   */
  deliveredOrders: number;
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
  /** A NAME, matched against what the column shows — see the two SQL consts. */
  salesAm?: string;
  backOfficeAm?: string;
  /**
   * "yes" for accounts marked as shops we deliver to, "no" for the rest, and
   * "delivered" for the ones the sheet shows receiving goods — whether or not
   * anybody has marked them yet. The third is the one that makes the marking
   * screen usable: it is the evidence, not the decision.
   */
  thirdParty?: "yes" | "no" | "delivered";
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
/* ---------------------------------------------------------------------------
 * Who an account answers to, as a NAME, in SQL.
 *
 * Defined once because three things have to agree about it: the column on the
 * customers list, the filter above that list, and the set of names the filter
 * offers. They did not. The filter tested `owner_id`'s name while the column
 * showed `coalesce(sales_person_name, sales_am_id)` — different people on most
 * rows, because the projection fills the sheet's name and `owner_id` is
 * whoever the record was imported under. Picking a name filtered a column
 * nobody could see, which reads exactly like a filter that does nothing.
 *
 * SALES is kind-aware, because the screen is: a lead answers to its owner and a
 * customer to its sales account manager, falling back to the owner. The
 * expression mirrors that fallback chain exactly, or the two disagree again on
 * whichever rows the chain reaches for.
 *
 * BACK OFFICE reads the account first and the sheet's name second — the
 * opposite order to sales, and deliberately so. `sales_am_id` is bulk-assigned
 * by the import, so reading it first names the telecaller who owns the book on
 * every customer; `back_office_am_id` is only ever set by a real link or by
 * somebody choosing, so it is the better answer where it exists.
 * ------------------------------------------------------------------------- */

export const SALES_AM_NAME_SQL = sql<string | null>`case
  when customers.kind = 'lead'
    then (select name from users u where u.id = customers.owner_id)
  else coalesce(
    customers.sales_person_name,
    (select name from users u where u.id = customers.sales_am_id),
    (select name from users u where u.id = customers.owner_id)
  )
end`;

export const BACK_OFFICE_AM_NAME_SQL = sql<string | null>`coalesce(
  (select name from users u where u.id = customers.back_office_am_id),
  customers.back_office_name
)`;

/**
 * The names each filter can offer.
 *
 * Read from the SAME expressions the column renders, and not from `users`,
 * because most of these people have no MahekOne account: the customer master
 * names "Back Office Calling", "Marathwada" and "Company Own" as salespeople,
 * and a dropdown built from the staff list cannot reach a single one of those
 * rows. A filter that cannot offer a value the table is showing is a filter
 * somebody tries once.
 *
 * Scoped like the list itself, so a telecaller is not shown the names of
 * people whose accounts they cannot see.
 */
export async function listAmFilterOptions(): Promise<{
  sales: string[];
  backOffice: string[];
}> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const scoped = scopedToUsers(ids);

  /*
   * Deduplicated in Postgres, which is where a distinct list comes from.
   *
   * This used to read a row per CUSTOMER — the whole book, each row carrying
   * two correlated subqueries against `users` — and reduce it to about fifteen
   * names with a JavaScript Set. The answer was always tiny; it was the
   * question that was the size of the book.
   *
   * The trim goes into the expression rather than being applied afterwards,
   * or " Vikram" and "Vikram" arrive as two distinct rows and dedupe back to
   * one only after crossing the wire.
   */
  const distinctNames = async (expr: SQL<string | null>) => {
    const trimmed = sql<string>`nullif(btrim(${expr}), '')`;
    const rows = await db
      .selectDistinct({ name: trimmed })
      .from(customers)
      .where(and(scoped, sql`${trimmed} is not null`));
    return rows
      .map((r) => r.name)
      // Sorted here rather than in SQL deliberately: `localeCompare` is what
      // ordered this list before, and Postgres's collation is not the same
      // comparison. Fifteen strings.
      .sort((a, b) => a.localeCompare(b));
  };

  const [sales, backOffice] = await Promise.all([
    distinctNames(SALES_AM_NAME_SQL),
    distinctNames(BACK_OFFICE_AM_NAME_SQL),
  ]);
  return { sales, backOffice };
}

export async function listCustomersPage(
  filters: CustomerListFilters = {},
): Promise<CustomerListPage> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const perPage = Math.min(Math.max(filters.perPage ?? 25, 1), 200);

  const scoped = scopedToUsers(ids);

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
  // The same expressions the column renders, so a name picked here always
  // matches the rows showing that name.
  if (filters.salesAm) {
    where.push(sql`${SALES_AM_NAME_SQL} = ${filters.salesAm}`);
  }
  if (filters.backOfficeAm) {
    where.push(sql`${BACK_OFFICE_AM_NAME_SQL} = ${filters.backOfficeAm}`);
  }
  if (filters.thirdParty === "yes") where.push(sql`customers.third_party`);
  if (filters.thirdParty === "no") where.push(sql`not customers.third_party`);
  if (filters.thirdParty === "delivered") {
    // Goods actually went here, on somebody else's bill. `customers.id` spelled
    // out: Drizzle renders the column reference bare, and a bare `id` inside a
    // correlated subquery binds to the INNER table and matches every row.
    where.push(sql`exists (
      select 1 from orders o where o.delivery_customer_id = customers.id
    )`);
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
      // The customer master's Sales Person first, and the linked account only
      // where the sheet is silent. Reading the account first showed the
      // telecaller who owns the book as the salesperson on every customer.
      salesAmName: SALES_AM_NAME_SQL,
      // The ACCOUNT first here, and the sheet's name second — the opposite of
      // the sales side above, deliberately. `sales_am_id` is bulk-assigned by
      // the import, so reading it first names the telecaller who owns the book
      // on every customer; `back_office_am_id` is only ever set by a real link
      // or a manager choosing somebody, so it is the better answer where it
      // exists, and the sheet's name is what stands in when it does not.
      backOfficeAmName: BACK_OFFICE_AM_NAME_SQL,
      openComplaints: sql<number>`(
        select count(*)::int from ${complaints}
         where complaints.customer_id = customers.id
           and ${complaints.status} in ('open','in_progress','awaiting_customer')
      )`,
      // `customers.id` spelled out for the reason the file already documents:
      // Drizzle renders the reference bare, and a bare `id` inside a correlated
      // subquery binds to the inner table and quietly matches everything.
      deliveredOrders: sql<number>`(
        select count(*)::int from orders o
         where o.delivery_customer_id = customers.id
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
      deliveredOrders: Number(r.deliveredOrders),
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
      // The customer master's Sales Person first, and the linked account only
      // where the sheet is silent. Reading the account first showed the
      // telecaller who owns the book as the salesperson on every customer.
      salesAmName: SALES_AM_NAME_SQL,
      // The ACCOUNT first here, and the sheet's name second — the opposite of
      // the sales side above, deliberately. `sales_am_id` is bulk-assigned by
      // the import, so reading it first names the telecaller who owns the book
      // on every customer; `back_office_am_id` is only ever set by a real link
      // or a manager choosing somebody, so it is the better answer where it
      // exists, and the sheet's name is what stands in when it does not.
      backOfficeAmName: BACK_OFFICE_AM_NAME_SQL,
      openComplaints: sql<number>`(
        select count(*)::int from ${complaints}
         where complaints.customer_id = customers.id
           and ${complaints.status} in ('open','in_progress','awaiting_customer')
      )`,
      deliveredOrders: sql<number>`(
        select count(*)::int from orders o
         where o.delivery_customer_id = customers.id
      )`,
    })
    .from(customers)
    .leftJoin(users, eq(users.id, customers.ownerId))
    .where(scopedToUsers(ids))
    .orderBy(asc(customers.name));

  return rows.map((r) => ({
    ...r.customer,
    ownerName: r.ownerName,
    salesAmName: r.salesAmName,
    backOfficeAmName: r.backOfficeAmName,
    openComplaints: Number(r.openComplaints),
      deliveredOrders: Number(r.deliveredOrders),
  }));
}

/**
 * Request-memoised: the customer record page asks for it twice, once in
 * `generateMetadata` to title the tab and once in the page itself, and Next
 * runs those in the same request. Nothing WRITES through here, so there is no
 * save that could read its own stale answer back.
 */
export const getCustomer = cache(async function getCustomer(
  customerId: string,
) {
  const rows = await db
    .select({
      customer: customers,
      ownerName: users.name,
      // The customer master's Sales Person first, and the linked account only
      // where the sheet is silent. Reading the account first showed the
      // telecaller who owns the book as the salesperson on every customer.
      salesAmName: SALES_AM_NAME_SQL,
      // The ACCOUNT first here, and the sheet's name second — the opposite of
      // the sales side above, deliberately. `sales_am_id` is bulk-assigned by
      // the import, so reading it first names the telecaller who owns the book
      // on every customer; `back_office_am_id` is only ever set by a real link
      // or a manager choosing somebody, so it is the better answer where it
      // exists, and the sheet's name is what stands in when it does not.
      backOfficeAmName: BACK_OFFICE_AM_NAME_SQL,
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
});

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

/**
 * The unified customer timeline, in one round trip.
 *
 * `limit` is for callers that want the most recent few — the call panel shows
 * three, and was reading a four-year customer's entire history to do it, every
 * time somebody opened it.
 *
 * The customer RECORD deliberately passes none. Its tabs count what is in each
 * kind — "Calls 47", "Orders 12" — so a capped read there would not shorten a
 * list, it would print a wrong number beside the word Calls, and nothing on the
 * screen would say it had been cut. Bounded per customer either way: every
 * branch below is `where … customer_id = …`, so this is one account's history
 * and never the table.
 */
export async function customerTimeline(
  customerId: string,
  limit?: number,
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
    ${limit ? sql`limit ${limit}` : sql``}
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
  return rangeActivity(userId, { from: target, to: target });
}

/**
 * The same figures over a span of days — the dashboard's week and month.
 *
 * A null user is the whole team in scope, summed. It is one query per person
 * either way, because the span is a window on the same query rather than a
 * query per day: a month costs exactly what a day costs.
 *
 * The connect rate is computed from the SUMMED calls, never averaged from
 * each person's or each day's rate. Averaging rates weights somebody who made
 * four calls the same as somebody who made ninety.
 */
export async function rangeActivity(
  userId: string | null,
  range: DateRange,
): Promise<DayActivity> {
  const metrics = userId
    ? await eodMetricsForRange(userId, range)
    : (
        await Promise.all(
          (await listTeam()).map((u) => eodMetricsForRange(u.id, range)),
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
  return teamRange({ from: target, to: target });
}

/**
 * The per-person table over a span.
 *
 * Overdue reminders are counted as at the END of the span and not summed over
 * it: a reminder overdue on Monday and still overdue on Friday is one overdue
 * reminder, and adding it up daily would report five.
 */
export async function teamRange(range: DateRange): Promise<TeamMemberDay[]> {
  const team = await listTeam();

  return Promise.all(
    team.map(async (user) => {
      const m = await eodMetricsForRange(user.id, range);
      const [row] = await db.execute<{ overdue: number }>(sql`
        select count(*)::int as overdue from reminders r
         where r.assigned_user_id = ${user.id} and r.status = 'pending'
           and r.due_date < ${range.to}::date
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
          scopedToUsers(ids),
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
          scopedToUsers(ids),
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

/**
 * Every time this account changed hands, newest first.
 *
 * Names are read from the ROW rather than joined to `users`, because the row
 * stored them at the time. Somebody who has since left keeps their name here —
 * a history that renders "unknown" for the person a change was made away from
 * answers the wrong half of the question it exists for.
 */
export async function listAmChanges(customerId: string) {
  const rows = await db
    .select({
      id: customerAmChanges.id,
      role: customerAmChanges.role,
      fromName: customerAmChanges.fromName,
      toName: customerAmChanges.toName,
      reasonCode: customerAmChanges.reasonCode,
      note: customerAmChanges.note,
      changedAt: customerAmChanges.changedAt,
      changedBy: sql<string | null>`(
        select name from users u where u.id = customer_am_changes.changed_by_id
      )`,
    })
    .from(customerAmChanges)
    .where(eq(customerAmChanges.customerId, customerId))
    .orderBy(desc(customerAmChanges.changedAt));

  return rows.map((r) => ({
    ...r,
    changedAt: r.changedAt as Date,
  }));
}

export { daysBetween, lte, orders, calls };
