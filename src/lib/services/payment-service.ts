import "server-only";
import { randomUUID } from "node:crypto";
import { cache } from "react";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  bills,
  customers,
  followUpAttempts,
  followUpStates,
  payments,
  reminders,
} from "@/db/schema";
import {
  ASSIGNED_TO_SQL,
  resolveScope,
  scopedUserIds,
  assertCustomerInScope, scopedToUsers,
  type RequestScope,
} from "../access-control";
import { getConfig } from "../config/store";
import { isAttemptAllowed, agingBucket, effectiveDueDate } from "../engines/escalation";
import {
  groupOutstanding,
  type OutstandingCustomer,
} from "../engines/outstanding";
import { billCreditDaysSql } from "../bill-terms";
import {
  nextCallOn,
  planPaymentFollowUps,
  type FollowUpDue,
  type FollowUpHeldBack,
} from "../engines/payment-followup";
import { recomputeFollowUpState, today } from "../recompute";
import { recordReceipt, reportedQuietByCustomer } from "./receipt-service";
import {
  addDays,
  calendarDate,
  daysBetween,
  daysInMonth,
  onOrAfterWorkingDay,
  type BusinessDate,
} from "../business-date";
import { financialYearRange } from "../financial-year";
import { err, ok, type Result } from "../result";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* ---------------------------------------------------------------------------
 * Payment follow-up.
 *
 * The worklist groups by CUSTOMER, never by bill: five overdue bills produce
 * one entry. Stage 1 is WhatsApp-only, and that is enforced here rather than
 * in the interface — a rule that exists only in the UI is not a rule.
 * ------------------------------------------------------------------------- */

export type WorklistRow = {
  customerId: string;
  name: string;
  ownerName: string | null;
  /** Whose account this is, by the assignment rule. Shown on team lists. */
  assignedToName: string | null;
  slowPayer: boolean;
  stage: number;
  daysOverdue: number;
  totalOverdue: number;
  overdueBillCount: number;
  nextChannel: "whatsapp" | "call";
  held: boolean;
  heldReason: string | null;
  lastFollowUpAt: string | null;
  lastChannel: "whatsapp" | "call" | null;
  nextAction: string;
  /** The most recent dated promise, if one is still live. */
  promisedAmount: number | null;
  promisedDate: string | null;
  promiseBroken: boolean;
  /** Paise reported paid and still waiting on accounts, and the day it was. */
  reportedAmount: number | null;
  reportedOn: string | null;
};

const NEXT_ACTION: Record<number, Record<"whatsapp" | "call", string>> = {
  1: { whatsapp: "Send the stage 1 nudge", call: "Send the stage 1 nudge" },
  2: { whatsapp: "Send the stage 2 message", call: "Call and get a dated promise" },
  3: { whatsapp: "Call - urgent", call: "Call - urgent" },
};

/**
 * The row, selected once.
 *
 * Lifted out so the paged read and the whole-set read cannot disagree about
 * what a worklist row IS — the same reason `toBillRow` sits beside `listBills`
 * one screen over.
 */
const WORKLIST_SELECT = {
      state: followUpStates,
      customer: customers,
      ownerName: sql<string | null>`(select name from users u where u.id = customers.owner_id)`,
      // Whose account this is, for the team list. Not the owner: whose book a
      // record sits in is ASSIGNED_TO_SQL, so the owner's name would put a
      // debt against somebody it was reassigned away from. The sheet's
      // salesperson is a NAME and most of those people have no account, so it
      // is preferred where there is one and the assigned user read underneath.
      assignedToName: sql<string | null>`coalesce(
        nullif(customers.sales_person_name, ''),
        (select name from users u where u.id = ${ASSIGNED_TO_SQL})
      )`,
      // The latest dated promise. A promise stays interesting after its date
      // passes — that is exactly when it becomes a broken promise.
      promisedAmount: sql<number | null>`(
        select a.promised_amount from follow_up_attempts a
         where a.customer_id = customers.id and a.promised_date is not null
         order by a.attempted_at desc limit 1
      )`,
      promisedDate: sql<string | null>`(
        select a.promised_date from follow_up_attempts a
         where a.customer_id = customers.id and a.promised_date is not null
         order by a.attempted_at desc limit 1
      )`,
      // Money reported against this account and not yet decided on. Shown
      // beside the name so a telecaller looking at an untouched balance knows
      // it is with accounts rather than with them.
      reportedAmount: sql<number | null>`(
        select sum(r.amount) from payment_receipts r
         where r.customer_id = customers.id and r.status in ('reported','held')
      )`,
      // Whether any of that undecided money has been PARKED by accounts. A
      // hold is a decision somebody made and does not expire; a bare report is
      // an unanswered claim whose quiet lapses. The row should not say the
      // same thing about both.
      paymentOnHold: sql<boolean>`exists (
        select 1 from payment_receipts r
         where r.customer_id = customers.id and r.status = 'held'
      )`,
      reportedOn: sql<string | null>`(
        select max((r.created_at at time zone 'Asia/Kolkata')::date)
          from payment_receipts r
         where r.customer_id = customers.id and r.status in ('reported','held')
      )`,
} as const;

function toWorklistRows(
  rows: Array<{
    state: typeof followUpStates.$inferSelect;
    customer: typeof customers.$inferSelect;
    ownerName: string | null;
    assignedToName: string | null;
    promisedAmount: number | null;
    promisedDate: string | null;
    reportedAmount: number | null;
    reportedOn: string | null;
    paymentOnHold: boolean;
  }>,
  day: BusinessDate,
): WorklistRow[] {
  return rows.map((
    { state, customer, ownerName, assignedToName, ...promise },
  ) => ({
    customerId: customer.id,
    name: customer.name,
    ownerName,
    assignedToName,
    slowPayer: customer.slowPayer,
    stage: state.stage,
    daysOverdue: state.daysOverdue,
    totalOverdue: state.totalOverdue,
    overdueBillCount: state.overdueBillCount,
    nextChannel: state.nextChannel,
    held: state.held,
    heldReason: state.heldReason,
    lastFollowUpAt: state.lastFollowUpAt?.toISOString() ?? null,
    lastChannel: state.lastChannel,
    promisedAmount: promise.promisedAmount === null ? null : Number(promise.promisedAmount),
    promisedDate: promise.promisedDate,
    // Promised, the date has passed, and the money is still outstanding.
    promiseBroken: Boolean(promise.promisedDate && promise.promisedDate < day),
    reportedAmount:
      promise.reportedAmount === null ? null : Number(promise.reportedAmount),
    reportedOn: promise.reportedOn,
    nextAction: state.held
      ? "Held - dispute open"
      : promise.reportedAmount
        ? promise.paymentOnHold
          ? "On hold with accounts - being checked"
          : "Reported paid - with accounts"
        : promise.promisedDate && promise.promisedDate < day
        ? "Promise broken - call today"
        : (NEXT_ACTION[state.stage]?.[state.nextChannel] ?? "Follow up"),
  }));
}

export async function getFollowUpWorklist(filters?: {
  stage?: number;
  slowPayersOnly?: boolean;
  monthEnd?: boolean;
}): Promise<WorklistRow[]> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const day = await today();

  const rows = await db
    .select(WORKLIST_SELECT)
    .from(followUpStates)
    .innerJoin(customers, eq(customers.id, followUpStates.customerId))
    .where(
      and(
        // Whose book, by the single definition in access-control. Reading
        // owner_id alone dropped every customer whose sales account manager
        // had been set — off the collections list while still owing money,
        // which is the one list nobody may quietly fall off.
        scopedToUsers(ids),
        filters?.stage ? eq(followUpStates.stage, filters.stage) : undefined,
        filters?.slowPayersOnly ? eq(customers.slowPayer, true) : undefined,
      ),
    );

  const mapped = toWorklistRows(rows, day);

  // Month-end sorts by collectable value; otherwise the oldest debt leads.
  return filters?.monthEnd
    ? mapped.sort((a, b) => b.totalOverdue - a.totalOverdue)
    : mapped.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

/* ------------------------------------------------------- the worklist, paged */

/**
 * WHICH BUCKET OF THE WORKLIST somebody is looking at.
 *
 * `calls` and `messages` are the day's cadence and are NOT columns: the
 * engine decides who is due, so the plan's own ids are handed in and the
 * clause is an `in`. The rest are questions the database can answer for
 * itself.
 */
export type WorklistTab =
  | "calls"
  | "messages"
  | "all"
  | "stage1"
  | "stage2"
  | "stage3"
  | "promised";

export const WORKLIST_TABS: readonly WorklistTab[] = [
  "calls",
  "messages",
  "all",
  "stage1",
  "stage2",
  "stage3",
  "promised",
];

export const WORKLIST_PER_PAGE = 25;

export type WorklistFilters = {
  tab?: WorklistTab;
  q?: string;
  slowOnly?: boolean;
  /** Sort by what is collectable rather than by what is oldest. */
  monthEnd?: boolean;
  page?: number;
  perPage?: number;
  /** Today's cadence, from the plan. The two engine-decided tabs. */
  callIds?: readonly string[];
  messageIds?: readonly string[];
};

export type WorklistPage = {
  rows: WorklistRow[];
  page: number;
  pageCount: number;
  perPage: number;
  /** Matching every filter, including the tab. */
  total: number;
  /** The whole scoped worklist, before any filter. */
  listTotal: number;
  /** Overdue paise over the FILTERED set, not the page. */
  filteredOverdue: number;
  /** Per-tab counts, over everything the other filters match. */
  counts: Record<WorklistTab, number>;
  held: number;
};

/**
 * ONE PAGE OF THE COLLECTIONS WORKLIST, counted in SQL.
 *
 * It used to be the whole thing: every scoped row serialised into the page,
 * then filtered, searched and sorted in the browser over an array it had
 * already been handed. That is the shape AGENTS.md records for the customer
 * record under COLOUR CAMP, and it fails the same way — the accounts with the
 * most overdue history are the ones somebody most needs to work, and they are
 * the ones the screen could show the least of.
 *
 * The rules it has to keep, which are this codebase's own and not new:
 *
 * **A CAPPED LIST SAYS WHAT IT IS A SLICE OF, AND THE COUNT COMES FROM SQL.**
 * The tab counts used to be `rows.filter(...).length` over everything the
 * browser held, which is exactly why the browser held everything. They are
 * `count(*) filter (...)` now, over the scoped set, so "Stage 3 · 41" is true
 * on a page of twenty-five.
 *
 * **A count is over everything the OTHER filters match.** Searching for a name
 * narrows every tab's count; standing on Stage 2 does not, or the tabs could
 * never tell you what moving to another one would show.
 *
 * **A paged read needs a tiebreaker in its sort.** Hundreds of rows share a
 * `days_overdue` and a whole book can share a `total_overdue` of zero, so
 * `order by days_overdue desc` alone leaves their order to the planner — which
 * is a row on two pages and another on none. The tiebreaker is the customer id.
 */
export async function followUpWorklistPage(
  filters: WorklistFilters = {},
): Promise<WorklistPage> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const day = await today();

  const perPage = Math.min(Math.max(filters.perPage ?? WORKLIST_PER_PAGE, 1), 200);
  const tab: WorklistTab = filters.tab ?? "calls";

  const scoped = scopedToUsers(ids);

  /*
   * A dated promise, as a clause rather than as the column the row selects.
   * The row reads the LATEST one for display; the filter only asks whether
   * there is one at all, which is the same question the browser was asking of
   * `Boolean(r.promisedDate)`.
   */
  const hasPromise = sql`exists (
    select 1 from follow_up_attempts a
     where a.customer_id = customers.id and a.promised_date is not null
  )`;

  /* Everything except the tab. The counts are taken over this. */
  const q = filters.q?.trim();
  const base = and(
    scoped,
    q ? sql`customers.name ilike ${"%" + q + "%"}` : undefined,
    filters.slowOnly ? eq(customers.slowPayer, true) : undefined,
  );

  /*
   * An empty set is "nobody", never "everybody" — the same rule `billsWhere`
   * spells out. On a quiet day the cadence genuinely has nobody on it, and a
   * missing clause there would show the entire book under "Due a call today".
   */
  const inIds = (list: readonly string[] | undefined) =>
    list && list.length
      ? inArray(customers.id, [...list])
      : sql`false`;

  const tabClause =
    tab === "calls"
      ? inIds(filters.callIds)
      : tab === "messages"
        ? inIds(filters.messageIds)
        : tab === "stage1"
          ? eq(followUpStates.stage, 1)
          : tab === "stage2"
            ? eq(followUpStates.stage, 2)
            : tab === "stage3"
              ? eq(followUpStates.stage, 3)
              : tab === "promised"
                ? hasPromise
                : undefined;

  const full = and(base, tabClause);

  const countsFrom = db
    .select({
      all: sql<number>`count(*)::int`,
      stage1: sql<number>`count(*) filter (where ${followUpStates.stage} = 1)::int`,
      stage2: sql<number>`count(*) filter (where ${followUpStates.stage} = 2)::int`,
      stage3: sql<number>`count(*) filter (where ${followUpStates.stage} = 3)::int`,
      promised: sql<number>`count(*) filter (where ${hasPromise})::int`,
      calls: sql<number>`count(*) filter (where ${inIds(filters.callIds)})::int`,
      messages: sql<number>`count(*) filter (where ${inIds(filters.messageIds)})::int`,
    })
    .from(followUpStates)
    .innerJoin(customers, eq(customers.id, followUpStates.customerId))
    .where(base);

  const matchedFrom = db
    .select({
      total: sql<number>`count(*)::int`,
      overdue: sql<number>`coalesce(sum(${followUpStates.totalOverdue}), 0)::bigint`,
    })
    .from(followUpStates)
    .innerJoin(customers, eq(customers.id, followUpStates.customerId))
    .where(full);

  const listFrom = db
    .select({
      n: sql<number>`count(*)::int`,
      /* Over the scoped book rather than the filtered set — see `held`. */
      held: sql<number>`count(*) filter (where ${followUpStates.held})::int`,
    })
    .from(followUpStates)
    .innerJoin(customers, eq(customers.id, followUpStates.customerId))
    .where(scoped);

  const [[counts], [matched], [book]] = await Promise.all([
    countsFrom,
    matchedFrom,
    listFrom,
  ]);

  const total = Number(matched?.total ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(filters.page ?? 1, 1), pageCount);

  const order = filters.monthEnd
    ? [desc(followUpStates.totalOverdue), desc(customers.id)]
    : [desc(followUpStates.daysOverdue), desc(customers.id)];

  const rows = await db
    .select(WORKLIST_SELECT)
    .from(followUpStates)
    .innerJoin(customers, eq(customers.id, followUpStates.customerId))
    .where(full)
    .orderBy(...order)
    .limit(perPage)
    .offset((page - 1) * perPage);

  return {
    rows: toWorklistRows(rows, day),
    page,
    pageCount,
    perPage,
    total,
    listTotal: Number(book?.n ?? 0),
    filteredOverdue: Number(matched?.overdue ?? 0),
    counts: {
      all: Number(counts?.all ?? 0),
      stage1: Number(counts?.stage1 ?? 0),
      stage2: Number(counts?.stage2 ?? 0),
      stage3: Number(counts?.stage3 ?? 0),
      promised: Number(counts?.promised ?? 0),
      calls: Number(counts?.calls ?? 0),
      messages: Number(counts?.messages ?? 0),
    },
    held: Number(book?.held ?? 0),
  };
}

/* --------------------------------------------------- today's follow-up plan */

export type PaymentFollowUpPlan = {
  calls: FollowUpDue[];
  messages: FollowUpDue[];
  heldBack: FollowUpHeldBack[];
};

/**
 * Who to ring and who to message today, and everybody deliberately left off
 * both lists. E3 says how overdue an account is; E7 says whether anything is
 * owed from it today.
 *
 * Every column of the outer table is written out in full inside the
 * subqueries — see AGENTS.md.
 */
export const getPaymentFollowUpPlan = cache(
  async function getPaymentFollowUpPlan(): Promise<PaymentFollowUpPlan> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const config = await getConfig();
  const day = await today();

  const rows = await db
    .select({
      state: followUpStates,
      customer: customers,
      // The last attempt of each channel, as business dates. A reminder sent
      // at 11pm belongs to that working day, not the next one.
      lastMessageOn: sql<string | null>`(
        select max((a.attempted_at at time zone 'Asia/Kolkata')::date)
          from follow_up_attempts a
         where a.customer_id = customers.id and a.channel = 'whatsapp'
      )`,
      lastCallOn: sql<string | null>`(
        select max((a.attempted_at at time zone 'Asia/Kolkata')::date)
          from follow_up_attempts a
         where a.customer_id = customers.id and a.channel = 'call'
      )`,
      promisedDate: sql<string | null>`(
        select a.promised_date from follow_up_attempts a
         where a.customer_id = customers.id and a.promised_date is not null
         order by a.attempted_at desc limit 1
      )`,
    })
    .from(followUpStates)
    .innerJoin(customers, eq(customers.id, followUpStates.customerId))
    .where(scopedToUsers(ids));

  // Money somebody has reported and accounts have not yet decided on. Read
  // once for the whole plan rather than per customer.
  const reported = await reportedQuietByCustomer();

  const plan = planPaymentFollowUps(
    rows.map(({ state, customer, ...last }) => ({
      customerId: customer.id,
      name: customer.name,
      // E3 already resolved which bill anchors the account and what its
      // effective due date is. Re-deriving it here is how two screens start
      // disagreeing about the same customer.
      anchorDueDate: state.oldestOverdueBillDate ?? addDays(day, -state.daysOverdue),
      totalOverdue: state.totalOverdue,
      overdueBillCount: state.overdueBillCount,
      lastMessageOn: last.lastMessageOn,
      lastCallOn: last.lastCallOn,
      doNotContact: customer.doNotContact,
      // A call today is a call today, whoever made it and whichever module
      // they made it from.
      contactedToday:
        customer.lastContactDate === day || customer.lastCallDate === day,
      held: state.held,
      heldReason: state.heldReason,
      promisedDate: last.promisedDate,
      reportedPayment: (() => {
        const r = reported.get(customer.id);
        return r
          ? {
              amount: r.amount,
              on: r.reportedOn,
              held: r.held,
              holdReason: r.holdReason,
              postDatedTo: r.postDatedTo,
            }
          : null;
      })(),
    })),
    day,
    config,
  );

  return plan;
});

/**
 * When collections next wants this one account called.
 *
 * The queue carries a verdict about TODAY — `paymentCallDue` — and a verdict
 * about today cannot be rolled forward. Asked "when do I speak to them next",
 * a customer with an overdue bill would answer "tomorrow" on every day of the
 * year, because the flag never turns itself off. This is the same rule the
 * worklist runs, `nextCallOn`, asked for a date instead of a yes.
 *
 * Null when there is no overdue debt on this customer at all.
 */
export async function paymentCadenceFor(customerId: string): Promise<{
  nextCallOn: string;
  totalOverdue: number;
  daysOverdue: number;
} | null> {
  const config = await getConfig();
  const day = await today();

  const [row] = await db
    .select({
      state: followUpStates,
      lastCallOn: sql<string | null>`(
        select max((a.attempted_at at time zone 'Asia/Kolkata')::date)
          from follow_up_attempts a
         where a.customer_id = ${followUpStates.customerId} and a.channel = 'call'
      )`,
      promisedDate: sql<string | null>`(
        select a.promised_date from follow_up_attempts a
         where a.customer_id = ${followUpStates.customerId}
           and a.promised_date is not null
         order by a.attempted_at desc limit 1
      )`,
    })
    .from(followUpStates)
    .where(eq(followUpStates.customerId, customerId));

  if (!row || row.state.totalOverdue <= 0) return null;

  // A disputed account has no cadence — somebody is handling it, and inventing
  // a date for it would put a chasing call on a telecaller's screen for a bill
  // that is under argument.
  if (row.state.held) return null;

  const anchorDueDate =
    row.state.oldestOverdueBillDate ?? addDays(day, -row.state.daysOverdue);

  let on = nextCallOn({ anchorDueDate, lastCallOn: row.lastCallOn }, config);

  /*
   * The two things that push the date out, in the same order the worklist
   * applies them. Reading the interval alone would answer "chase them in three
   * days" to a telecaller who has just been promised the money on the 20th —
   * which is the one call that must not be made.
   */
  const reported = (await reportedQuietByCustomer()).get(customerId);
  if (reported) {
    const until = addDays(reported.reportedOn, config["payments.reportedQuietDays"]);
    if (until > on) on = until;
  }
  if (row.promisedDate && row.promisedDate >= day) {
    const until = addDays(row.promisedDate, 1);
    if (until > on) on = until;
  }

  return {
    nextCallOn: on,
    totalOverdue: row.state.totalOverdue,
    daysOverdue: row.state.daysOverdue,
  };
}

export async function getFollowUpDetail(customerId: string) {
  const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!customer) return null;
  await assertCustomerInScope(customer);

  const config = await getConfig();
  const day = await today();

  const [state] = await db
    .select()
    .from(followUpStates)
    .where(eq(followUpStates.customerId, customerId));

  const billRows = await db
    .select({ bill: bills, creditDays: billCreditDaysSql })
    .from(bills)
    .where(eq(bills.customerId, customerId))
    .orderBy(asc(bills.billDate));

  const attempts = await db
    .select()
    .from(followUpAttempts)
    .where(eq(followUpAttempts.customerId, customerId))
    .orderBy(desc(followUpAttempts.attemptedAt))
    .limit(20);

  return {
    customer,
    state: state ?? null,
    attempts,
    bills: billRows.map(({ bill: b, creditDays }) => {
      const due = effectiveDueDate(
        {
          id: b.id, billNo: b.billNo, billDate: b.billDate, dueDate: b.dueDate,
          creditDays: creditDays === null ? null : Number(creditDays),
          amount: b.amount, paid: b.paidAmount, disputed: b.disputed,
        },
        config,
      );
      const balance = b.amount - b.paidAmount;
      const overdueDays = balance > 0 ? Math.max(0, daysBetween(due, day)) : 0;
      return {
        ...b,
        effectiveDueDate: due,
        balance,
        overdueDays,
        bucket: agingBucket(overdueDays, config),
      };
    }),
  };
}

/* -------------------------------------------------------- record an attempt */

export const attemptSchema = z.object({
  customerId: z.string().min(1),
  channel: z.enum(["whatsapp", "call"]),
  outcome: z.string().optional(),
  promisedAmount: z.number().int().positive().optional(),
  promisedDate: z.string().optional(),
  idempotencyKey: z.string().min(8),
});

export async function recordFollowUpAttempt(
  raw: z.input<typeof attemptSchema>,
): Promise<Result<{ attemptId: string; reminderId: string | null }>> {
  const parsed = attemptSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(issue.message, "validation", [
      { field: issue.path.join("."), message: issue.message },
    ]);
  }
  const input = parsed.data;

  const ctx = await resolveScope();
  const config = await getConfig();
  const day = await today();

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, input.customerId));
  if (!customer) return err("That customer no longer exists.", "not_found");
  await assertCustomerInScope(customer);

  const [existingAttempt] = await db
    .select({ id: followUpAttempts.id })
    .from(followUpAttempts)
    .where(eq(followUpAttempts.idempotencyKey, input.idempotencyKey));
  if (existingAttempt) {
    return ok({ attemptId: existingAttempt.id, reminderId: null }, "Already recorded");
  }

  const [state] = await db
    .select()
    .from(followUpStates)
    .where(eq(followUpStates.customerId, input.customerId));
  if (!state) {
    return err(
      "That customer has nothing overdue - they are not on the collections worklist.",
      "rule_violation",
    );
  }

  // Stage 1 is a WhatsApp-only nudge. Rejected here, with a clear reason.
  const allowed = isAttemptAllowed(state.stage as 1 | 2 | 3, input.channel);
  if (!allowed.allowed) {
    return err(allowed.error, "rule_violation");
  }

  const attemptId = id("fua");
  let reminderId: string | null = null;

  await db.transaction(async (tx) => {
    if (input.promisedAmount && input.promisedDate) {
      // A promise nobody chases is just a note; chase it the day after.
      reminderId = id("rem");
      const due = onOrAfterWorkingDay(addDays(input.promisedDate, 1), {
        timezone: config["workingDay.timezone"],
        dayBoundaryHour: config["workingDay.dayBoundaryHour"],
        workingDays: config["workingDay.workingDays"],
      });
      await tx.insert(reminders).values({
        id: reminderId,
        customerId: input.customerId,
        createdByUserId: ctx.user.id,
        assignedUserId: ctx.user.id,
        dueDate: due,
        note: `Check ₹${Math.round(input.promisedAmount / 100).toLocaleString("en-IN")} promised for ${input.promisedDate}`,
        type: "payment_promise",
        systemGenerated: true,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
    }

    await tx.insert(followUpAttempts).values({
      id: attemptId,
      customerId: input.customerId,
      stage: state.stage,
      channel: input.channel,
      attemptedAt: new Date(),
      userId: ctx.user.id,
      outcome: input.outcome ?? null,
      promisedAmount: input.promisedAmount ?? null,
      promisedDate: input.promisedDate ?? null,
      reminderId,
      idempotencyKey: input.idempotencyKey,
      createdById: ctx.user.id,
    });

    await tx
      .update(followUpStates)
      .set({
        lastChannel: input.channel,
        lastFollowUpAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(followUpStates.customerId, input.customerId));

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "followup.attempt",
      entityType: "customer",
      entityId: input.customerId,
      afterState: { stage: state.stage, channel: input.channel } as never,
    });
  });

  await recomputeFollowUpState(input.customerId);
  void day;
  return ok({ attemptId, reminderId }, "Follow-up recorded");
}

/* ------------------------------------------------------------ record payment */

export const paymentSchema = z.object({
  billId: z.string().min(1),
  amount: z.number().int().positive(),
  paidAt: z.string().min(1),
  mode: z.string().default("Bank transfer"),
  reference: z.string().optional(),
  /** The date on the cheque, where the mode carries one — see payments.datedModes. */
  instrumentDate: z.string().optional(),
  idempotencyKey: z.string().min(8),
});

/**
 * A payment against one named bill, as the bills ledger and the collections
 * screens ask for it.
 *
 * Kept as its own entry point because that is genuinely how it is asked from
 * those screens — the person is already looking at a bill — but it is a
 * receipt underneath like everything else, so it goes through the same
 * confirmation, the same audit trail and the same ledger. What it no longer
 * does is move `bills.paidAmount` itself: whether this money counts depends on
 * whether whoever recorded it can confirm money, and that lives in one place.
 */
export async function recordPayment(
  raw: z.input<typeof paymentSchema>,
): Promise<Result<{ paymentId: string }>> {
  const parsed = paymentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(issue.message, "validation", [
      { field: issue.path.join("."), message: issue.message },
    ]);
  }
  const input = parsed.data;

  const [bill] = await db.select().from(bills).where(eq(bills.id, input.billId));
  if (!bill) return err("That bill no longer exists.", "not_found");

  const result = await recordReceipt({
    customerId: bill.customerId,
    amount: input.amount,
    receivedAt: input.paidAt,
    mode: input.mode,
    reference: input.reference,
    instrumentDate: input.instrumentDate,
    allocation: "custom",
    custom: { [bill.id]: input.amount },
    source: "bills_screen",
    idempotencyKey: input.idempotencyKey,
  });
  if (!result.ok) return result;

  return ok({ paymentId: result.data.receiptId }, result.message);
}

/* ----------------------------------------------------------------- bills */

export type BillFilters = {
  customerId?: string;
  /**
   * `unpaid`, `partially_paid` or `paid` — the stored column, not a derived
   * word. It sat here unread for as long as it has existed: the Bills ledger
   * declared it and then filtered on it in the browser, over an array it had
   * already been sent. A filter that decides a `count(*)` has to be in the
   * query the count comes from.
   */
  status?: string;
  /**
   * An explicit set of bills, for the one filter SQL cannot express.
   *
   * The aging bucket is `agingBucket(effectiveDueDate(...))` — two pure
   * functions and the whole reason the figures on these screens agree. Rather
   * than write a third spelling of them into a `where` clause, the caller
   * buckets the OPEN bills it is already reading for the aging strip (a few
   * hundred rows, never the ledger) and names the ones it wants.
   *
   * An EMPTY array means no bills, never every bill — the same rule
   * `customerIds` above states, for the same reason.
   */
  billIds?: string[];
  /** "26-27". Absent means every year, which the export uses. */
  financialYear?: string;
  /**
   * Only bills with something still open on them.
   *
   * For a LEDGER this would be wrong — a settled bill is most of what the year
   * consists of and the table exists to show it. For collections it is the
   * whole question: the payment screen reads every bill in the book and then
   * throws away every settled one in JavaScript to find the few a customer
   * still owes on.
   *
   * Deliberately NOT the financial-year filter the ledger uses. An open bill
   * from a previous year is the oldest debt on the account and therefore the
   * first thing collections chases — cutting the payment screen by year would
   * hide exactly the rows it exists to show.
   */
  openOnly?: boolean;
  /**
   * The oldest bill date worth having, as `YYYY-MM-DD`.
   *
   * A WINDOW rather than the financial year above, because MBOS asks for a
   * rolling one: "this financial year" on a handset has to keep working on the
   * 2nd of April, and a year filter answers that with two bills. Deliberately
   * not the same knob — a year is a thing somebody picks off a list, a window
   * is a thing a payload is sized by.
   */
  from?: string;
  /**
   * Only bills touched since this instant, for a caller sending changes.
   *
   * A bill's row moves when a receipt against it is confirmed, which is what
   * makes this usable as a delta at all. It is only honest where the caller
   * asks for EVERY bill in a window: with `openOnly` a bill can leave the set
   * by being settled, and a row that has left carries no cursor to say so.
   */
  updatedSince?: Date;
  /**
   * A SET of customers, for a caller that has already worked out which.
   *
   * `customerId` answers "this one shop", which is what every screen asks.
   * MBOS asks the other question — the whole book on one handset — and it has
   * already narrowed that book itself. Reading the bills through here rather
   * than through a query of its own is the same rule
   * `listOutstandingByCustomer` follows and for the same reason: the due date
   * resolved from the term, the aging bucket and `paymentPosition` are worked
   * out in ONE place, so a salesman standing in the shop and the accounts
   * clerk on the ledger cannot be looking at two different answers about one
   * bill.
   *
   * An EMPTY array means no customers, not every customer. A caller that has
   * narrowed to nothing must get nothing — falling through to the whole book
   * is how a handset receives a ledger it was never entitled to.
   */
  customerIds?: string[];
};

/** 1 April to 31 March, as SQL. The end is exclusive — see financial-year.ts. */
function financialYearWhere(fy?: string) {
  if (!fy) return undefined;
  const { start, end } = financialYearRange(fy);
  return and(gte(bills.billDate, start), lt(bills.billDate, end));
}

/** The oldest bill in scope, so the filter offers only years that exist. */
export async function earliestBillDate(): Promise<string | null> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const [row] = await db
    .select({ d: sql<string | null>`min(${bills.billDate})` })
    .from(bills)
    .innerJoin(customers, eq(customers.id, bills.customerId))
    .where(scopedToUsers(ids));
  return row?.d ?? null;
}

/**
 * `context` is for a caller with no session cookie to resolve a scope FROM.
 *
 * MBOS authenticates a handset with a bearer token and has already resolved
 * the salesman's scope through `scopeForUser` — the single statement of what
 * "mine" means. Passing it in narrows this read exactly as the cookie path
 * narrows it, without a second opinion about who may see which book. A caller
 * that omits it gets `resolveScope()`, which is every screen.
 */
/**
 * WHICH BILLS THE CALLER IS ASKING ABOUT — one clause, four readers.
 *
 * `listBills` builds the rows, `billLedgerTotals` sums them, `billLedgerAging`
 * buckets the open ones and `billLedgerPage` cuts a page out. Four questions
 * about the same set, and a set that four functions each defined for
 * themselves would be four screens quietly disagreeing about what is in the
 * financial year.
 */
function billsWhere(ids: string[] | null, filters?: BillFilters) {
  return and(
    scopedToUsers(ids),
    filters?.customerId ? eq(bills.customerId, filters.customerId) : undefined,
    /* An empty set is "no customers", never "all of them" — see the note
       on the filter. `inArray` with nothing is false, which is what we
       want, but it is spelled out rather than left to the driver. */
    filters?.customerIds
      ? filters.customerIds.length
        ? inArray(bills.customerId, filters.customerIds)
        : sql`false`
      : undefined,
    financialYearWhere(filters?.financialYear),
    filters?.status ? eq(bills.status, filters.status as "unpaid") : undefined,
    filters?.billIds
      ? filters.billIds.length
        ? inArray(bills.id, filters.billIds)
        : sql`false`
      : undefined,
    filters?.openOnly ? sql`${bills.amount} > ${bills.paidAmount}` : undefined,
    /* Both arrived on main while this helper was being extracted. They belong
       here rather than at one call site, or the paged read and the whole-set
       read would disagree about which bills are in the list — which is the
       exact drift the helper exists to prevent. */
    filters?.from ? gte(bills.billDate, filters.from) : undefined,
    filters?.updatedSince ? gt(bills.updatedAt, filters.updatedSince) : undefined,
  );
}

export async function listBills(filters?: BillFilters, context?: RequestScope) {
  const ctx = context ?? (await resolveScope());
  const ids = scopedUserIds(ctx.scope);
  const config = await getConfig();
  const day = await today();

  const rows = await db
    .select({
      bill: bills,
      customerName: customers.name,
      customerId: customers.id,
      creditDays: billCreditDaysSql,
    })
    .from(bills)
    .innerJoin(customers, eq(customers.id, bills.customerId))
    .where(billsWhere(ids, filters))
    .orderBy(desc(bills.billDate));

  return rows.map((r) => toBillRow(r, config, day));
}

/**
 * One bill row, derived once.
 *
 * Lifted out of `listBills` so the paged read and the whole-set read produce
 * the same shape from the same rules — two copies of this would be two
 * definitions of when a bill is due, which is the drift this file is otherwise
 * careful to avoid.
 */
function toBillRow(
  r: {
    bill: typeof bills.$inferSelect;
    customerName: string;
    customerId: string;
    creditDays: unknown;
  },
  config: Awaited<ReturnType<typeof getConfig>>,
  day: BusinessDate,
) {
  const b = r.bill;
  const due = effectiveDueDate(
    {
      id: b.id,
      billNo: b.billNo,
      billDate: b.billDate,
      dueDate: b.dueDate,
      creditDays: r.creditDays === null ? null : Number(r.creditDays),
      amount: b.amount,
      paid: b.paidAmount,
      disputed: b.disputed,
    },
    config,
  );
  const balance = b.amount - b.paidAmount;
  const overdueDays = balance > 0 ? Math.max(0, daysBetween(due, day)) : 0;
  return {
    id: b.id,
    billNo: b.billNo,
    customerId: r.customerId,
    customerName: r.customerName,
    billDate: b.billDate,
    dueDate: due,
    amount: b.amount,
    paid: b.paidAmount,
    balance,
    overdueDays,
    bucket: agingBucket(overdueDays, config),
    status: b.status,
    disputed: b.disputed,
    /* The order this bill was raised against. A bill IS the order here — see
       AGENTS.md — so this is the only way to what was actually on it. */
    orderId: b.orderId,
    updatedAt: b.updatedAt,
    /*
     * Whether anybody has said this bill was paid or is owed.
     *
     * Carried on the row rather than left to each caller to fetch, because a
     * screen showing a balance has to be able to say which kind of number it
     * is: on an `unstated` bill the balance is the full amount purely because
     * nothing has been recorded against it either way.
     */
    paymentPosition: b.paymentPosition,
  };
}

export type BillRow = Awaited<ReturnType<typeof listBills>>[number];


/* ------------------------------------------- the due date, spelled in SQL */

/**
 * `effectiveDueDate` AND `agingBucket`'s input, in SQL — used only to decide
 * ORDER and MEMBERSHIP, never to produce a figure anybody reads.
 *
 * `billLedgerPage`'s own note says that not one business rule moved into SQL,
 * and that stands for every NUMBER on these screens: the due date on a row,
 * the days overdue beside it and the aging bucket are all still
 * `effectiveDueDate` and `agingBucket` in JavaScript, from the one definition
 * this codebase has of them.
 *
 * What SQL cannot avoid knowing is which rows come first and which rows are in
 * the set at all. A ledger sorted by due date and paged in Postgres has to sort
 * by a due date Postgres can see, and "who is past a due date" is a filter that
 * decides a `count(*)`. Shipping ten thousand rows to answer either is the
 * thing this whole change exists to stop.
 *
 * So the duplication is real and it is BOUNDED, in the one direction that
 * fails visibly: if this fragment ever drifts from the engine, rows come back
 * in the wrong order — they do not come back carrying a wrong figure. And it
 * is not left to a promise: `bill-paging.test.ts` puts a book of bills through
 * both spellings and asserts they agree on every one.
 *
 * `coalesce(credit days, default)::int` rather than a bare parameter, for the
 * reason AGENTS.md records about `plan_date >= now() - $days`: an untyped
 * parameter beside a date lets Postgres resolve the arithmetic as `date - date`
 * and the query throws.
 */
function effectiveDueDateSql(defaultCreditDays: number) {
  /* Every column written out in full, the way `billCreditDaysSql` beside it
     is and for the same reason: Drizzle renders a column reference BARE
     inside a sql template, and a bare name is what binds to the wrong table
     the moment this fragment is used in a join or a subquery. */
  return sql`coalesce(
    bills.due_date,
    bills.bill_date + coalesce(${billCreditDaysSql}, ${defaultCreditDays}::int)::int
  )`;
}

/**
 * How many days past its due date a bill is, as the row reads it.
 *
 * A settled bill is never overdue — `toBillRow` has always said so with
 * `balance > 0 ? daysBetween(...) : 0` — and that branch is here too, or
 * sorting by "Overdue" would rank a bill paid in March above one that is a
 * fortnight late.
 */
function overdueDaysSql(day: BusinessDate, defaultCreditDays: number) {
  return sql`case
    when bills.amount > bills.paid_amount
    then greatest(0, ${day}::date - (${effectiveDueDateSql(defaultCreditDays)})::date)
    else 0
  end`;
}

export type BillSortKey =
  | "billNo"
  | "billDate"
  | "dueDate"
  | "customerName"
  | "amount"
  | "paid"
  | "balance"
  | "overdueDays";

export type BillSort = { key: BillSortKey; dir: "asc" | "desc" };

/** Every column the ledger's head offers, as the expression Postgres sorts on. */
function billSortSql(key: BillSortKey, day: BusinessDate, defaultCreditDays: number) {
  switch (key) {
    case "billNo":
      return sql`bills.bill_no`;
    case "billDate":
      return sql`bills.bill_date`;
    case "dueDate":
      return effectiveDueDateSql(defaultCreditDays);
    case "customerName":
      return sql`customers.name`;
    case "amount":
      return sql`bills.amount`;
    case "paid":
      return sql`bills.paid_amount`;
    case "balance":
      return sql`bills.amount - bills.paid_amount`;
    case "overdueDays":
      return overdueDaysSql(day, defaultCreditDays);
  }
}

/**
 * THE LEDGER, WITHOUT SENDING THE WHOLE LEDGER.
 *
 * `listBills` returns every row that matches, and the Bills screens then
 * filtered, sorted and sliced it in the browser. The pager worked; it was
 * paging a set the server had already fetched, parsed into ten thousand
 * JavaScript objects and serialised into the page — 2.4 MB of HTML on this
 * book, so that fifty rows could be shown. Clicking page 2 was free because
 * page 1 had already paid for all of it.
 *
 * It was built that way to keep a real rule: the totals and the aging strip
 * describe the WHOLE filtered set, not the page, because a total that changed
 * as you paged would be a different figure on every click. That rule stands.
 * What changes is how it is honoured — reads shaped to their questions instead
 * of one read shaped to none:
 *
 *   1. the page itself, LIMIT/OFFSET, wide — twenty-five or fifty rows
 *   2. the totals, one aggregate row out of Postgres
 *   3. the aging, narrow and OPEN BILLS ONLY
 *
 * **AND ALMOST NO BUSINESS RULE MOVED INTO SQL.** Every FIGURE on the screen is
 * still `effectiveDueDate` and `agingBucket` in JavaScript, from the one
 * definition this codebase has of each: the totals are sums of columns and need
 * no due date at all, and a bucket only ever applies to a bill with a balance,
 * so the aging read is a few hundred rows that the SAME pure functions bucket.
 * The aging FILTER does not go into the clause either — the caller names the
 * bills in the band by id.
 *
 * The one exception is `effectiveDueDateSql`, and its own note says what it is
 * for and what keeps it honest: sorting a paged ledger by due date, and the
 * aging strip's "past due" question, are things Postgres has to be able to
 * decide for itself. It decides ORDER and MEMBERSHIP and never a number.
 */
export async function billLedgerPage(
  filters: BillFilters | undefined,
  paging: { page: number; perPage: number; sort?: BillSort },
): Promise<{ rows: BillRow[]; total: number }> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const config = await getConfig();
  const day = await today();

  const perPage = Math.min(Math.max(paging.perPage, 1), 200);
  const page = Math.max(paging.page, 1);
  /* Newest bill first, which is what somebody checking what has just gone out
     opens the ledger for. The screen may ask for another column; it may not
     ask for one that is not here, so a hand-typed `?sort=` cannot reach the
     query. */
  const sort: BillSort = paging.sort ?? { key: "billDate", dir: "desc" };
  const order = billSortSql(sort.key, day, config["bills.defaultCreditDays"]);
  const direction = sort.dir === "asc" ? sql`asc` : sql`desc`;

  const [rows, [counted]] = await Promise.all([
    db
      .select({
        bill: bills,
        customerName: customers.name,
        customerId: customers.id,
        creditDays: billCreditDaysSql,
      })
      .from(bills)
      .innerJoin(customers, eq(customers.id, bills.customerId))
      .where(billsWhere(ids, filters))
      /* THE TIEBREAKER IS NOT OPTIONAL. A thousand bills share a handful of
         dates — and on a column like Status or Paid, ten thousand share four
         values — so the chosen column alone leaves the rest of the order to
         the planner. Invisible until it is paged, and then it is a row
         appearing on two pages while another appears on none. `id desc` is the
         same answer the customer timeline's cursor already gives. */
      .orderBy(sql`${order} ${direction}`, desc(bills.id))
      .limit(perPage)
      .offset((page - 1) * perPage),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(bills)
      .innerJoin(customers, eq(customers.id, bills.customerId))
      .where(billsWhere(ids, filters)),
  ]);

  return {
    rows: rows.map((r) => toBillRow(r, config, day)),
    total: counted?.n ?? 0,
  };
}

/** Billed, received and open over the WHOLE filtered set — one aggregate row,
 *  and no due date needed, because these are sums of columns. */
export async function billLedgerTotals(
  filters?: BillFilters,
): Promise<{ billed: number; received: number; open: number; count: number }> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const [row] = await db
    .select({
      billed: sql<string>`coalesce(sum(${bills.amount}), 0)`,
      received: sql<string>`coalesce(sum(${bills.paidAmount}), 0)`,
      open: sql<string>`coalesce(sum(greatest(${bills.amount} - ${bills.paidAmount}, 0)), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(bills)
    .innerJoin(customers, eq(customers.id, bills.customerId))
    .where(billsWhere(ids, filters));

  return {
    billed: Number(row?.billed ?? 0),
    received: Number(row?.received ?? 0),
    open: Number(row?.open ?? 0),
    count: row?.count ?? 0,
  };
}

/**
 * The ages of the OPEN bills, for the aging strip.
 *
 * A settled bill has no overdue days by definition — `toBillRow` has always
 * said so, with `balance > 0 ? daysBetween(...) : 0` — so the whole of the
 * aging question lives in the few hundred rows that still owe something.
 * Six small columns instead of the whole ledger.
 *
 * It returns what `bucketise` takes and does no banding of its own for the
 * strip: the bands, their order and their labels are that function's, and a
 * second implementation here would be a second answer to "how old is this
 * money" on the one screen whose subject is that question.
 *
 * It DOES carry the bill's id and `agingBucket`'s own word, because the ledger
 * lets somebody click a band to filter by it and the query behind that page
 * cannot see a bucket — see `BillFilters.billIds`. Same rows, same pure
 * function, one read: the strip and the filter it offers cannot disagree about
 * which bills are in a band.
 */
export async function openBillAges(
  filters?: BillFilters,
): Promise<Array<{ id: string; overdueDays: number; balance: number; bucket: string }>> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const config = await getConfig();
  const day = await today();

  const rows = await db
    .select({
      id: bills.id,
      billNo: bills.billNo,
      billDate: bills.billDate,
      dueDate: bills.dueDate,
      amount: bills.amount,
      paid: bills.paidAmount,
      disputed: bills.disputed,
      creditDays: billCreditDaysSql,
    })
    .from(bills)
    .innerJoin(customers, eq(customers.id, bills.customerId))
    .where(and(billsWhere(ids, filters), sql`${bills.amount} > ${bills.paidAmount}`));

  return rows.map((b) => {
    const due = effectiveDueDate(
      {
        id: b.id,
        billNo: b.billNo,
        billDate: b.billDate,
        dueDate: b.dueDate,
        creditDays: b.creditDays === null ? null : Number(b.creditDays),
        amount: b.amount,
        paid: b.paid,
        disputed: b.disputed,
      },
      config,
    );
    const overdueDays = Math.max(0, daysBetween(due, day));
    return {
      id: b.id,
      overdueDays,
      balance: b.amount - b.paid,
      bucket: agingBucket(overdueDays, config),
    };
  });
}

/**
 * Who owes us money, one row per customer, with the bills behind each.
 *
 * The ledger answers "what did we bill"; this answers "who owes us", which is
 * where both a collections call and an accounts chase actually start. It reads
 * `listBills` rather than a second query of its own — a screen totalling
 * outstanding from one read of the bills while the ledger showed another is
 * exactly how two screens come to disagree about one customer.
 *
 * Scope-aware through `listBills`: a telecaller sees their own book.
 */
export async function listOutstandingByCustomer(): Promise<OutstandingCustomer[]> {
  // Every open bill, across every financial year. Deliberately NOT cut by
  // year: the oldest debt on an account is usually last year's, and it is the
  // first thing anybody chases.
  const rows = await listBills({ openOnly: true });
  return groupOutstanding(rows);
}


/* ------------------------------------------------------- outstanding, paged */

export type OutstandingSort = "owed" | "oldest" | "name";

export type OutstandingFilters = {
  /** A name to find. The screen's search box, moved off the browser's array. */
  query?: string;
  /** Only customers with something past its due date. */
  overdueOnly?: boolean;
  sort?: OutstandingSort;
  page?: number;
  perPage?: number;
};

export type OutstandingPage = {
  /** ONE PAGE of customers, each with its own open bills. */
  rows: OutstandingCustomer[];
  /** Every customer the filters match, from a count in Postgres. */
  total: number;
  page: number;
  perPage: number;
  /** The figures above the table. They describe all of `total`, not the page. */
  totals: {
    customers: number;
    outstanding: number;
    bills: number;
    overdueCustomers: number;
    overdue: number;
    unstatedCustomers: number;
    unstatedAmount: number;
  };
};

/**
 * WHO OWES US, A PAGE AT A TIME.
 *
 * `listOutstandingByCustomer` reads every open bill in the book and groups
 * them, which is the right answer to the question and the wrong amount of it
 * to send anywhere: on this book it was 3.3 MB of HTML — every open bill,
 * plus a nested list of them under every customer — so that a browser could
 * show twenty-five names.
 *
 * It is deliberately still NOT cut by financial year. The oldest debt on an
 * account is usually last year's and that is the first row anybody works.
 * What changes is the amount of it that travels: the grouping happens in
 * Postgres to decide WHO is on the page and what the figures above it are, and
 * only those customers' bills are then read and handed to `groupOutstanding`.
 *
 * So the engine stays pure and stays the authority on every number a person
 * reads — the outstanding on a row, the worst bucket, the bills behind it, and
 * the rule that an `unstated` bill is counted apart and never added in. It is
 * simply fed twenty-five customers instead of seven thousand.
 *
 * The aggregate is written once and asked twice, as a CTE: a second copy of
 * "what does this customer owe" is how a total and the rows under it come to
 * disagree, which is the exact failure this screen exists to avoid.
 */
export async function outstandingPage(
  filters: OutstandingFilters = {},
): Promise<OutstandingPage> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const config = await getConfig();
  const day = await today();

  const perPage = Math.min(Math.max(filters.perPage ?? 25, 1), 200);
  const sort: OutstandingSort = filters.sort ?? "owed";
  const query = filters.query?.trim() ?? "";

  const overdue = overdueDaysSql(day, config["bills.defaultCreditDays"]);
  /* `stated` is a stored column, so this one is not a rule being respelled:
     it is the same enum the engine reads, asked of Postgres. */
  const stated = sql`bills.payment_position = 'stated'`;
  const balance = sql`bills.amount - bills.paid_amount`;

  const where =
    and(
      scopedToUsers(ids),
      sql`bills.amount > bills.paid_amount`,
      /* Escaped, because this used to be `String.includes` in a browser and a
         customer named "A_1" must not start matching "AB1" merely because the
         search moved into SQL. */
      query
        ? sql`customers.name ilike ${
            "%" + query.replace(/([\\%_])/g, "\\$1") + "%"
          } escape '\\'`
        : undefined,
    ) ?? sql`true`;

  /* Past due means a STATED bill past its date. An unstated bill is not debt,
     so it cannot make somebody overdue — the same rule the engine follows when
     it leaves one out of `oldestOverdueDays`. */
  const having = filters.overdueOnly
    ? sql`having coalesce(max(${overdue}) filter (where ${stated}), 0) > 0`
    : sql``;

  const grouped = sql`
    select customers.id   as customer_id,
           coalesce(sum(${balance}) filter (where ${stated}), 0)            as outstanding,
           count(*) filter (where ${stated})::int                           as open_bills,
           coalesce(sum(${balance}) filter (where not ${stated}), 0)        as unstated_amount,
           count(*) filter (where not ${stated})::int                       as unstated_bills,
           coalesce(max(${overdue}) filter (where ${stated}), 0)::int       as oldest_overdue_days,
           coalesce(sum(${balance}) filter (where ${stated} and ${overdue} > 0), 0) as overdue_amount,
           customers.name as customer_name
      from bills
      join customers on customers.id = bills.customer_id
     where ${where}
     group by customers.id, customers.name
     ${having}
  `;

  /*
   * THE ORDER, WITH A TIEBREAKER ON EVERY ONE OF THEM.
   *
   * Thousands of customers owe nothing stated and sort as a block of zeroes;
   * on "oldest" a whole beat shares one overdue day. A single column is the
   * planner's choice after that, which is a customer on two pages and another
   * on none. The customer id closes it, exactly as the bill ledger's does.
   *
   * "owed" is the engine's own order, restated: what is owed, then what is
   * merely unspoken for, then the name. Somebody who owes nothing stated is
   * work of a different kind rather than work of no kind, so they sort below
   * everybody who does and not out of the list.
   */
  const order =
    sort === "name"
      ? sql`customer_name asc, customer_id asc`
      : sort === "oldest"
        ? sql`oldest_overdue_days desc, outstanding desc, customer_id asc`
        : sql`outstanding desc, unstated_amount desc, customer_name asc, customer_id asc`;

  /*
   * THE COUNT FIRST, then the page — the shape `listCustomersPage` already
   * uses, and not an optimisation waiting to be undone. The page number has to
   * be clamped to a page that exists before an OFFSET is spent on it, or
   * somebody who filters down from page seven is served an empty table rather
   * than the last page of what they asked for.
   */
  const totalsRows = await db.execute<{
    customers: number;
    matched: number;
    outstanding: string;
    bills: number;
    overdue_customers: number;
    overdue: string;
    unstated_customers: number;
    unstated_amount: string;
  }>(sql`
    with per_customer as (${grouped})
    select count(*) filter (where outstanding > 0)::int          as customers,
           count(*)::int                                        as matched,
           coalesce(sum(outstanding), 0)                        as outstanding,
           coalesce(sum(open_bills), 0)::int                    as bills,
           count(*) filter (where oldest_overdue_days > 0)::int as overdue_customers,
           coalesce(sum(overdue_amount), 0)                     as overdue,
           count(*) filter (where unstated_bills > 0)::int      as unstated_customers,
           coalesce(sum(unstated_amount), 0)                    as unstated_amount
      from per_customer
  `);

  const agg = totalsRows[0];
  const total = Number(agg?.matched ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(filters.page ?? 1, 1), pageCount);

  const totals = {
    customers: Number(agg?.customers ?? 0),
    outstanding: Number(agg?.outstanding ?? 0),
    bills: Number(agg?.bills ?? 0),
    overdueCustomers: Number(agg?.overdue_customers ?? 0),
    overdue: Number(agg?.overdue ?? 0),
    unstatedCustomers: Number(agg?.unstated_customers ?? 0),
    unstatedAmount: Number(agg?.unstated_amount ?? 0),
  };

  if (!total) return { rows: [], total, page, perPage, totals };

  const picked = await db.execute<{ customer_id: string }>(sql`
    with per_customer as (${grouped})
    select customer_id from per_customer
     order by ${order}
     limit ${perPage}::int offset ${(page - 1) * perPage}::int
  `);
  const pageIds = picked.map((r) => r.customer_id);

  /*
   * And now the engine, on twenty-five customers' bills.
   *
   * Through `listBills` rather than a query of its own, for the reason that
   * function's own note gives: the due date resolved from the term, the aging
   * bucket and the payment position are worked out in ONE place, so this
   * screen and the ledger cannot be looking at two different answers about one
   * bill. `customerIds` is what it is for.
   */
  const rows = groupOutstanding(
    await listBills({ openOnly: true, customerIds: pageIds }),
  );

  /* Back into the order Postgres chose. `groupOutstanding` sorts by what is
     owed — which is right when it IS the list, and wrong when the list has
     already been ordered by a name or by an age and cut at twenty-five. */
  const byId = new Map(rows.map((r) => [r.customerId, r]));
  return {
    rows: pageIds.map((cid) => byId.get(cid)).filter((r) => r !== undefined),
    total,
    page,
    perPage,
    totals,
  };
}

/**
 * The aging strip, over bills the caller has ALREADY read.
 *
 * It used to call `listBills(filters)` itself, which meant every screen
 * showing a ledger and a strip above it ran the identical full-ledger query
 * twice in one request — and the two could not even be told apart in a slow
 * query log, being the same SQL with the same parameters.
 *
 * Pure, and no longer async: `listBills` has already banded every row, so this
 * needs neither configuration nor the business date to sum what it is given.
 * A summary derived from a different read than the table underneath it is how
 * a strip and a ledger come to disagree about one year.
 */
export function agingSummary(rows: BillRow[]) {
  const buckets = new Map<string, number>();
  for (const r of rows) {
    if (r.balance <= 0) continue;
    buckets.set(r.bucket, (buckets.get(r.bucket) ?? 0) + r.balance);
  }
  return {
    total: rows.reduce((a, r) => a + r.balance, 0),
    buckets: [...buckets.entries()].map(([label, amount]) => ({ label, amount })),
  };
}

/* --------------------------------------------------------- collections figures */

export type CollectionsMetrics = {
  /** Open balance across the book, and how many customers carry it. */
  outstanding: number;
  outstandingCustomers: number;
  /** How the open balance moved over the last seven days: new bills less payments. */
  outstandingChange: number;
  /** The urgent stage, and the threshold that defines it. */
  urgent: number;
  urgentCustomers: number;
  urgentThresholdDays: number;
  /** Dated promises that have not yet come due. */
  promisedOpen: number;
  promisedCount: number;
  /** Promises whose date fell in the last 30 days, and how many were met. */
  promisesKeptPercent: number | null;
  promisesJudged: number;
  /** The same figure for the 30 days before, so the trend is real and not a guess. */
  promisesKeptPreviousPercent: number | null;
  /** Money in this month, against what fell due in it. */
  collectedThisMonth: number;
  dueThisMonth: number;
  collectedThisWeek: number;
};

/**
 * The figures across the top of the payment screen. Every one is derived from
 * bills, payments and recorded promises — there is no stored collections
 * summary to drift out of date.
 *
 * Scope-aware, like every other read here: a telecaller sees their own book.
 */
export async function collectionsMetrics(): Promise<CollectionsMetrics> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const config = await getConfig();
  const day = await today();

  const weekAgo = addDays(day, -7);
  const monthStart = `${day.slice(0, 7)}-01`;
  // addMonths works on month keys, not dates — the last day comes from the
  // month's own length.
  const monthEnd = `${day.slice(0, 8)}${String(daysInMonth(day)).padStart(2, "0")}`;

  /*
   * Whose book, by the single definition in access-control — `scopedToUsers`,
   * which is what the worklist DIRECTLY BENEATH these figures is filtered by.
   *
   * Two things were wrong with doing it in JavaScript here. The predicate
   * never reached Postgres, so every bill, every payment, every follow-up
   * state and every promise in the company crossed the wire on each load to
   * have most of them dropped one row later. And the copy had drifted: it
   * tested the sales account manager alone, while `scopedToUsers` is the sales
   * manager OR the back office one. A customer whose back-office manager was
   * the reader counted in the list and not in the total above it, which is a
   * strip and a table disagreeing about one book — the exact failure the move
   * off `owner_id` was meant to end, surviving in the half nobody re-read.
   */
  const scoped = scopedToUsers(ids);

  /* ---- bills: the open balance, and what falls due this month ---- */

  // Still row-by-row, because the due date is `effectiveDueDate` and that is
  // an ENGINE — the term chain resolves order, then customer, then the
  // configured default, and a second copy of it written in SQL would be a
  // second answer to when a bill is due. What changed is that these are now
  // only the reader's bills.
  const billRows = await db
    .select({
      customerId: bills.customerId,
      billDate: bills.billDate,
      dueDate: bills.dueDate,
      creditDays: billCreditDaysSql,
      amount: bills.amount,
      paid: bills.paidAmount,
      disputed: bills.disputed,
      billNo: bills.billNo,
      id: bills.id,
    })
    .from(bills)
    .innerJoin(customers, eq(customers.id, bills.customerId))
    .where(scoped);

  const mine = billRows;

  let outstanding = 0;
  let dueThisMonth = 0;
  let raisedThisWeek = 0;
  const owing = new Set<string>();

  for (const b of mine) {
    const balance = b.amount - b.paid;
    if (balance > 0) {
      outstanding += balance;
      owing.add(b.customerId);
    }
    const due = effectiveDueDate(
      {
        id: b.id,
        billNo: b.billNo,
        billDate: b.billDate,
        dueDate: b.dueDate,
        creditDays: b.creditDays === null ? null : Number(b.creditDays),
        amount: b.amount,
        paid: b.paid,
        disputed: b.disputed,
      },
      config,
    );
    if (due >= monthStart && due <= monthEnd) dueThisMonth += b.amount;
    if (b.billDate > weekAgo) raisedThisWeek += b.amount;
  }

  /* ---- payments: what came in ---- */

  const paymentRows = await db
    .select({
      customerId: payments.customerId,
      amount: payments.amount,
      paidAt: payments.paidAt,
    })
    .from(payments)
    .innerJoin(customers, eq(customers.id, payments.customerId))
    .where(scoped);

  const minePayments = paymentRows;
  const collectedThisMonth = minePayments
    .filter((p) => p.paidAt >= monthStart && p.paidAt <= day)
    .reduce((sum, p) => sum + p.amount, 0);
  const collectedThisWeek = minePayments
    .filter((p) => p.paidAt > weekAgo)
    .reduce((sum, p) => sum + p.amount, 0);

  // Indexed by customer for the kept-promise check below, which used to scan
  // every payment in the book once per promise.
  const paymentsByCustomer = new Map<string, typeof minePayments>();
  for (const p of minePayments) {
    const list = paymentsByCustomer.get(p.customerId);
    if (list) list.push(p);
    else paymentsByCustomer.set(p.customerId, [p]);
  }

  /* ---- the urgent stage ---- */

  // Summed in Postgres. Only stage 3 was ever wanted, and this read every
  // follow-up state in the company to count a handful of them.
  const [urgentRow] = await db
    .select({
      total: sql<string>`coalesce(sum(${followUpStates.totalOverdue}), 0)`,
      customers: sql<string>`count(*)`,
    })
    .from(followUpStates)
    .innerJoin(customers, eq(customers.id, followUpStates.customerId))
    .where(and(scoped, eq(followUpStates.stage, 3)));

  /* ---- promises: what is open, and what was kept ---- */

  // Everything asked of promises below looks at one of three windows: open
  // (dated today or later), judged in the last 30 days, and judged in the 30
  // before that. Their union starts 60 days back and runs forward without
  // limit, so that is what is fetched — rather than every promise ever made.
  const promiseFloor = addDays(day, -60);

  const promiseRows = await db
    .select({
      customerId: followUpAttempts.customerId,
      amount: followUpAttempts.promisedAmount,
      date: followUpAttempts.promisedDate,
      at: followUpAttempts.attemptedAt,
    })
    .from(followUpAttempts)
    .innerJoin(customers, eq(customers.id, followUpAttempts.customerId))
    .where(
      and(
        scoped,
        isNotNull(followUpAttempts.promisedDate),
        isNotNull(followUpAttempts.promisedAmount),
        gte(followUpAttempts.promisedDate, promiseFloor),
      ),
    );

  const promises = promiseRows.map((p) => ({
    customerId: p.customerId,
    amount: Number(p.amount),
    date: p.date!,
    madeOn: calendarDate(p.at),
  }));

  const open = promises.filter((p) => p.date >= day);

  // A promise was kept when at least the promised amount reached us between
  // the day it was made and the day it was for. Judged only once the date has
  // passed — an open promise is neither kept nor broken yet.
  const keptRate = (from: string, to: string): { percent: number | null; judged: number } => {
    const judged = promises.filter((p) => p.date >= from && p.date < to);
    if (!judged.length) return { percent: null, judged: 0 };
    const kept = judged.filter((p) => {
      // That customer's payments, not the whole book's. This was a scan of
      // every payment in scope for every promise being judged — the two lists
      // multiplied, twice over, for two thirty-day windows.
      const paid = (paymentsByCustomer.get(p.customerId) ?? [])
        .filter((q) => q.paidAt >= p.madeOn && q.paidAt <= p.date)
        .reduce((sum, q) => sum + q.amount, 0);
      return paid >= p.amount;
    }).length;
    return { percent: Math.round((kept / judged.length) * 100), judged: judged.length };
  };

  const last30 = keptRate(addDays(day, -30), day);
  const previous30 = keptRate(addDays(day, -60), addDays(day, -30));

  return {
    outstanding,
    outstandingCustomers: owing.size,
    outstandingChange: raisedThisWeek - collectedThisWeek,
    urgent: Number(urgentRow?.total ?? 0),
    urgentCustomers: Number(urgentRow?.customers ?? 0),
    urgentThresholdDays: config["escalation.stage3Days"],
    promisedOpen: open.reduce((sum, p) => sum + p.amount, 0),
    promisedCount: open.length,
    promisesKeptPercent: last30.percent,
    promisesJudged: last30.judged,
    promisesKeptPreviousPercent: previous30.percent,
    collectedThisMonth,
    dueThisMonth,
    collectedThisWeek,
  };
}
