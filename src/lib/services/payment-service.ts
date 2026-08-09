import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
  assertCustomerInScope,
} from "../access-control";
import { getConfig } from "../config/store";
import { isAttemptAllowed, agingBucket, effectiveDueDate } from "../engines/escalation";
import { billCreditDaysSql } from "../bill-terms";
import {
  planPaymentFollowUps,
  type FollowUpDue,
  type FollowUpHeldBack,
} from "../engines/payment-followup";
import { recomputeFollowUpState, recomputeOutstanding, recomputeBillStatuses, today } from "../recompute";
import {
  addDays,
  daysBetween,
  daysInMonth,
  onOrAfterWorkingDay,
} from "../business-date";
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
};

const NEXT_ACTION: Record<number, Record<"whatsapp" | "call", string>> = {
  1: { whatsapp: "Send the stage 1 nudge", call: "Send the stage 1 nudge" },
  2: { whatsapp: "Send the stage 2 message", call: "Call and get a dated promise" },
  3: { whatsapp: "Call - urgent", call: "Call - urgent" },
};

export async function getFollowUpWorklist(filters?: {
  stage?: number;
  slowPayersOnly?: boolean;
  monthEnd?: boolean;
}): Promise<WorklistRow[]> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);

  const day = await today();

  const rows = await db
    .select({
      state: followUpStates,
      customer: customers,
      ownerName: sql<string | null>`(select name from users u where u.id = customers.owner_id)`,
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
    })
    .from(followUpStates)
    .innerJoin(customers, eq(customers.id, followUpStates.customerId))
    .where(
      and(
        // Whose book, by the single definition in access-control. Reading
        // owner_id alone dropped every customer whose sales account manager
        // had been set — off the collections list while still owing money,
        // which is the one list nobody may quietly fall off.
        ids ? inArray(ASSIGNED_TO_SQL, ids) : undefined,
        filters?.stage ? eq(followUpStates.stage, filters.stage) : undefined,
        filters?.slowPayersOnly ? eq(customers.slowPayer, true) : undefined,
      ),
    );

  const mapped: WorklistRow[] = rows.map(({ state, customer, ownerName, ...promise }) => ({
    customerId: customer.id,
    name: customer.name,
    ownerName,
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
    nextAction: state.held
      ? "Held - dispute open"
      : promise.promisedDate && promise.promisedDate < day
        ? "Promise broken - call today"
        : (NEXT_ACTION[state.stage]?.[state.nextChannel] ?? "Follow up"),
  }));

  // Month-end sorts by collectable value; otherwise the oldest debt leads.
  return filters?.monthEnd
    ? mapped.sort((a, b) => b.totalOverdue - a.totalOverdue)
    : mapped.sort((a, b) => b.daysOverdue - a.daysOverdue);
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
export async function getPaymentFollowUpPlan(): Promise<PaymentFollowUpPlan> {
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
    .where(ids ? inArray(ASSIGNED_TO_SQL, ids) : undefined);

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
    })),
    day,
    config,
  );

  return plan;
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
  idempotencyKey: z.string().min(8),
});

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
  const ctx = await resolveScope();

  const [bill] = await db.select().from(bills).where(eq(bills.id, input.billId));
  if (!bill) return err("That bill no longer exists.", "not_found");

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, bill.customerId));
  await assertCustomerInScope(customer ?? null);

  const balance = bill.amount - bill.paidAmount;
  if (input.amount > balance) {
    return err(
      `That is more than the ₹${Math.round(balance / 100).toLocaleString("en-IN")} still open on this bill.`,
      "validation",
      [{ field: "amount", message: "Cannot exceed the outstanding balance." }],
    );
  }

  const [dupe] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.externalRef, input.idempotencyKey));
  if (dupe) return ok({ paymentId: dupe.id }, "Already recorded");

  const paymentId = id("pay");
  await db.transaction(async (tx) => {
    await tx.insert(payments).values({
      id: paymentId,
      billId: bill.id,
      customerId: bill.customerId,
      amount: input.amount,
      paidAt: input.paidAt,
      mode: input.mode,
      reference: input.reference ?? null,
      externalRef: input.idempotencyKey,
      recordedById: ctx.user.id,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });
    await tx
      .update(bills)
      .set({ paidAmount: bill.paidAmount + input.amount, updatedAt: new Date() })
      .where(eq(bills.id, bill.id));
    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "payment.record",
      entityType: "bill",
      entityId: bill.id,
      beforeState: { paidAmount: bill.paidAmount } as never,
      afterState: { paidAmount: bill.paidAmount + input.amount } as never,
    });
  });

  await recomputeBillStatuses();
  await recomputeOutstanding(bill.customerId);
  // Full payment removes the customer from the worklist immediately.
  await recomputeFollowUpState(bill.customerId);

  return ok({ paymentId }, "Payment recorded");
}

/* ----------------------------------------------------------------- bills */

export async function listBills(filters?: { customerId?: string; status?: string }) {
  const ctx = await resolveScope();
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
    .where(
      and(
        ids ? inArray(ASSIGNED_TO_SQL, ids) : undefined,
        filters?.customerId ? eq(bills.customerId, filters.customerId) : undefined,
      ),
    )
    .orderBy(desc(bills.billDate));

  return rows.map(({ bill: b, customerName, customerId, creditDays }) => {
    const due = effectiveDueDate(
      { id: b.id, billNo: b.billNo, billDate: b.billDate, dueDate: b.dueDate,
        creditDays: creditDays === null ? null : Number(creditDays),
        amount: b.amount, paid: b.paidAmount, disputed: b.disputed },
      config,
    );
    const balance = b.amount - b.paidAmount;
    const overdueDays = balance > 0 ? Math.max(0, daysBetween(due, day)) : 0;
    return {
      id: b.id,
      billNo: b.billNo,
      customerId,
      customerName,
      billDate: b.billDate,
      dueDate: due,
      amount: b.amount,
      paid: b.paidAmount,
      balance,
      overdueDays,
      bucket: agingBucket(overdueDays, config),
      status: b.status,
      disputed: b.disputed,
    };
  });
}

export async function agingSummary() {
  const config = await getConfig();
  const rows = await listBills();
  const buckets = new Map<string, number>();
  for (const r of rows) {
    if (r.balance <= 0) continue;
    const key = agingBucket(r.overdueDays, config);
    buckets.set(key, (buckets.get(key) ?? 0) + r.balance);
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

  const inScope = (ownerId: string | null) =>
    !ids || (ownerId !== null && ids.includes(ownerId));

  /* ---- bills: the open balance, and what falls due this month ---- */

  const billRows = await db
    .select({
      customerId: bills.customerId,
      ownerId: customers.ownerId,
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
    .innerJoin(customers, eq(customers.id, bills.customerId));

  const mine = billRows.filter((b) => inScope(b.ownerId));

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
      ownerId: customers.ownerId,
      amount: payments.amount,
      paidAt: payments.paidAt,
    })
    .from(payments)
    .innerJoin(customers, eq(customers.id, payments.customerId));

  const minePayments = paymentRows.filter((p) => inScope(p.ownerId));
  const collectedThisMonth = minePayments
    .filter((p) => p.paidAt >= monthStart && p.paidAt <= day)
    .reduce((sum, p) => sum + p.amount, 0);
  const collectedThisWeek = minePayments
    .filter((p) => p.paidAt > weekAgo)
    .reduce((sum, p) => sum + p.amount, 0);

  /* ---- the urgent stage ---- */

  const stateRows = await db
    .select({ state: followUpStates, ownerId: customers.ownerId })
    .from(followUpStates)
    .innerJoin(customers, eq(customers.id, followUpStates.customerId));
  const urgentRows = stateRows.filter((r) => inScope(r.ownerId) && r.state.stage === 3);

  /* ---- promises: what is open, and what was kept ---- */

  const promiseRows = await db
    .select({
      customerId: followUpAttempts.customerId,
      ownerId: customers.ownerId,
      amount: followUpAttempts.promisedAmount,
      date: followUpAttempts.promisedDate,
      at: followUpAttempts.attemptedAt,
    })
    .from(followUpAttempts)
    .innerJoin(customers, eq(customers.id, followUpAttempts.customerId))
    .where(and(isNotNull(followUpAttempts.promisedDate), isNotNull(followUpAttempts.promisedAmount)));

  const promises = promiseRows
    .filter((p) => inScope(p.ownerId))
    .map((p) => ({
      customerId: p.customerId,
      amount: Number(p.amount),
      date: p.date!,
      madeOn: p.at.toISOString().slice(0, 10),
    }));

  const open = promises.filter((p) => p.date >= day);

  // A promise was kept when at least the promised amount reached us between
  // the day it was made and the day it was for. Judged only once the date has
  // passed — an open promise is neither kept nor broken yet.
  const keptRate = (from: string, to: string): { percent: number | null; judged: number } => {
    const judged = promises.filter((p) => p.date >= from && p.date < to);
    if (!judged.length) return { percent: null, judged: 0 };
    const kept = judged.filter((p) => {
      const paid = minePayments
        .filter(
          (q) => q.customerId === p.customerId && q.paidAt >= p.madeOn && q.paidAt <= p.date,
        )
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
    urgent: urgentRows.reduce((sum, r) => sum + r.state.totalOverdue, 0),
    urgentCustomers: urgentRows.length,
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
