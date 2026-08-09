import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, bills, customers, paymentReceipts, payments } from "@/db/schema";
import {
  ASSIGNED_TO_SQL,
  assertCustomerInScope,
  can,
  requireCapability,
  resolveScope,
  scopedUserIds,
} from "../access-control";
import { getConfig } from "../config/store";
import { allocate, type AllocatableBill } from "../engines/allocation";
import { effectiveDueDate } from "../engines/escalation";
import { billCreditDaysSql } from "../bill-terms";
import {
  recomputeBillPaid,
  recomputeBillStatuses,
  recomputeFollowUpState,
  recomputeOutstanding,
  today,
} from "../recompute";
import { bindAttachments } from "./attachment-service";
import { err, ok, type Result } from "../result";

/* ---------------------------------------------------------------------------
 * Receipts — money arriving, and whether the business has seen it.
 *
 * A receipt is one arrival of money. Its allocation lines say which bills it
 * settles. Between the two sits a status, and that status is the whole point:
 * a telecaller told on a call that the customer has paid can write it down
 * immediately, the customer stops being chased for it, and NOTHING moves in
 * the ledger until accounts find the money in the bank.
 *
 * The alternative — which this replaces — was that the telecaller's word
 * reduced outstanding on the spot. A transfer that never landed then erased
 * real debt from every screen, with nobody's name against the decision.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

const rupees = (paise: number) =>
  `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;

/* ------------------------------------------------------------- open bills */

export type OpenBill = {
  id: string;
  billNo: string;
  billDate: string;
  dueDate: string;
  amount: number;
  paid: number;
  balance: number;
  daysOverdue: number;
  /** Paise sitting on reported-but-unconfirmed receipts against this bill. */
  reported: number;
  orderId: string | null;
};

/**
 * What is open on an account, oldest first, with the money already claimed
 * against each bill shown beside it. Accounts need that second figure at the
 * moment of entry: without it the same UTR gets applied twice, once by the
 * telecaller who was told about it and once by whoever is looking at the bank.
 */
export async function openBillsFor(customerId: string): Promise<OpenBill[]> {
  const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!customer) return [];
  await assertCustomerInScope(customer);

  const config = await getConfig();
  const day = await today();

  const rows = await db
    .select({
      bill: bills,
      creditDays: billCreditDaysSql,
      // Every column of the outer table is written out in full — a bare
      // "id" inside a correlated subquery binds to the inner table.
      reported: sql<number>`coalesce((
        select sum(p.amount) from payments p
          join payment_receipts r on r.id = p.receipt_id
         where p.bill_id = bills.id and r.status = 'reported'
      ), 0)::bigint`,
    })
    .from(bills)
    .where(and(eq(bills.customerId, customerId), gt(sql`${bills.amount} - ${bills.paidAmount}`, 0)))
    .orderBy(asc(bills.billDate), asc(bills.billNo));

  return rows.map(({ bill: b, creditDays, reported }) => {
    const due = effectiveDueDate(
      {
        id: b.id,
        billNo: b.billNo,
        billDate: b.billDate,
        dueDate: b.dueDate,
        creditDays: creditDays === null ? null : Number(creditDays),
        amount: b.amount,
        paid: b.paidAmount,
        disputed: b.disputed,
      },
      config,
    );
    return {
      id: b.id,
      billNo: b.billNo,
      billDate: b.billDate,
      dueDate: due,
      amount: b.amount,
      paid: b.paidAmount,
      balance: b.amount - b.paidAmount,
      daysOverdue: due < day ? Math.round((Date.parse(day) - Date.parse(due)) / 86_400_000) : 0,
      reported: Number(reported ?? 0),
      orderId: b.orderId,
    };
  });
}

/* --------------------------------------------------------- recording money */

export const receiptSchema = z.object({
  customerId: z.string().min(1),
  /** Paise. */
  amount: z.number().int().positive(),
  receivedAt: z.string().min(1),
  mode: z.string().min(1),
  reference: z.string().trim().optional(),
  note: z.string().trim().optional(),
  allocation: z.enum(["auto", "settle", "custom"]).default("auto"),
  selectedBillIds: z.array(z.string()).default([]),
  /** Paise against each bill id, for a custom split. */
  custom: z.record(z.string(), z.number().int().nonnegative()).default({}),
  source: z
    .enum(["accounts", "collections_call", "bills_screen", "sheet_import"])
    .default("accounts"),
  idempotencyKey: z.string().min(8),
  attachmentIds: z.array(z.string()).default([]),
});

export type RecordReceiptInput = z.input<typeof receiptSchema>;

export type RecordReceiptResult = {
  receiptId: string;
  status: "reported" | "confirmed";
  allocated: number;
  onAccount: number;
  billsTouched: number;
};

export async function recordReceipt(
  raw: RecordReceiptInput,
): Promise<Result<RecordReceiptResult>> {
  const parsed = receiptSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(issue.message, "validation", [
      { field: issue.path.join("."), message: issue.message },
    ]);
  }
  const input = parsed.data;

  const ctx = await requireCapability("payment.record");
  const config = await getConfig();

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, input.customerId));
  if (!customer) return err("That customer no longer exists.", "not_found");
  await assertCustomerInScope(customer);

  if (!config["payments.modes"].includes(input.mode)) {
    return err("That is not a payment mode we record.", "validation", [
      { field: "mode", message: "Pick one of the offered modes." },
    ]);
  }

  const day = await today();
  if (input.receivedAt > day) {
    return err("Money cannot have arrived in the future.", "validation", [
      { field: "receivedAt", message: "Pick today or a day already past." },
    ]);
  }

  // Re-running a save that already succeeded returns the same receipt rather
  // than a second one. The form retries; the money arrived once.
  const [dupe] = await db
    .select({ id: paymentReceipts.id, status: paymentReceipts.status })
    .from(paymentReceipts)
    .where(eq(paymentReceipts.idempotencyKey, input.idempotencyKey));
  if (dupe) {
    return ok(
      {
        receiptId: dupe.id,
        status: dupe.status === "confirmed" ? "confirmed" : "reported",
        allocated: 0,
        onAccount: 0,
        billsTouched: 0,
      },
      "Already recorded",
    );
  }

  const open = await openBillsFor(input.customerId);
  const allocatable: AllocatableBill[] = open.map((b) => ({
    id: b.id,
    billNo: b.billNo,
    billDate: b.billDate,
    amount: b.amount,
    // Money already claimed against a bill is not offered to a second receipt.
    // Two people recording the same transfer is the ordinary failure here.
    paid: b.paid + b.reported,
  }));

  const result = allocate(allocatable, {
    mode: input.allocation,
    amount: input.amount,
    selectedBillIds: input.selectedBillIds,
    custom: input.custom,
    allowOnAccount: config["payments.allowOnAccountRemainder"],
  });
  if (result.errors.length) {
    return err(result.errors[0], "validation", [
      { field: "allocation", message: result.errors.join(" ") },
    ]);
  }

  /*
   * Who is recording it decides whether it is believed. Accounts hold the bank
   * statement, so what they enter is confirmed as it is written — asking them
   * to confirm their own entry on a second screen would be a queue of their
   * own keystrokes. Everybody else reports.
   */
  const confirms = can(ctx.role, "payment.confirm") && input.source !== "collections_call";
  const status = confirms ? "confirmed" : "reported";

  /*
   * A reference is demanded of whoever ASSERTS the money is in the bank, and
   * of nobody else.
   *
   * Accounts match a receipt against the statement by this string, so one
   * confirmed without it is money nobody can find again. But a telecaller
   * relaying what a customer said on the phone usually has no UTR to give,
   * and refusing the save would lose the claim entirely — which costs more
   * than a receipt accounts have to go looking for. They are reporting, not
   * asserting, and the person who does assert it will supply the reference.
   */
  if (
    confirms &&
    config["payments.referenceRequiredModes"].includes(input.mode) &&
    !input.reference
  ) {
    return err(`A ${input.mode.toLowerCase()} needs its reference.`, "validation", [
      {
        field: "reference",
        message: "Enter the UTR, cheque number or transaction reference.",
      },
    ]);
  }

  const receiptId = id("rcp");
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(paymentReceipts).values({
      id: receiptId,
      customerId: input.customerId,
      amount: input.amount,
      receivedAt: input.receivedAt,
      mode: input.mode,
      reference: input.reference || null,
      note: input.note || null,
      status,
      source: input.source,
      reportedById: ctx.user.id,
      confirmedById: confirms ? ctx.user.id : null,
      confirmedAt: confirms ? now : null,
      idempotencyKey: input.idempotencyKey,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });

    for (const line of result.lines) {
      await tx.insert(payments).values({
        id: id("pay"),
        receiptId,
        billId: line.billId,
        customerId: input.customerId,
        amount: line.amount,
        paidAt: input.receivedAt,
        mode: input.mode,
        reference: input.reference || null,
        // One key per line, so a retried save cannot double-apply any of them.
        externalRef: `${input.idempotencyKey}:${line.billId ?? "on-account"}`,
        recordedById: ctx.user.id,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
    }

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "payment.record",
      entityType: "payment_receipt",
      entityId: receiptId,
      afterState: {
        amount: input.amount,
        status,
        mode: input.mode,
        reference: input.reference ?? null,
        allocation: input.allocation,
        lines: result.lines,
      } as never,
    });
  });

  // §5.2 — outside the transaction on purpose. A proof photograph that failed
  // to upload is not worth rolling back money that has actually arrived.
  if (input.attachmentIds.length) {
    await bindAttachments(input.attachmentIds, "payment_receipt", receiptId).catch(
      () => {},
    );
  }

  if (confirms) await applyToLedger(input.customerId);

  const billsTouched = result.lines.filter((l) => l.billId).length;
  return ok(
    {
      receiptId,
      status,
      allocated: result.allocated,
      onAccount: result.onAccount,
      billsTouched,
    },
    confirms
      ? `${rupees(input.amount)} received from ${customer.name}`
      : `${rupees(input.amount)} recorded — waiting for accounts to confirm it`,
  );
}

/**
 * Every cached figure that follows from confirmed money, in dependency order.
 * Each of these reads what the one before it wrote, so the order is not
 * cosmetic.
 */
async function applyToLedger(customerId: string): Promise<void> {
  await recomputeBillPaid(customerId);
  await recomputeBillStatuses();
  await recomputeOutstanding(customerId);
  // A fully settled account leaves the collections worklist immediately.
  await recomputeFollowUpState(customerId);
}

/* --------------------------------------------------------- the confirm queue */

export type PendingReceipt = {
  receiptId: string;
  customerId: string;
  customerName: string;
  amount: number;
  receivedAt: string;
  mode: string;
  reference: string | null;
  note: string | null;
  source: string;
  reportedBy: string | null;
  reportedAt: string;
  waitingHours: number;
  /** What it would settle, if confirmed. */
  lines: Array<{ billId: string | null; billNo: string | null; amount: number }>;
  /** The customer's whole open balance, for context. */
  outstanding: number;
};

/** Everything waiting on accounts, longest wait first. */
export async function pendingReceipts(): Promise<PendingReceipt[]> {
  await requireCapability("payment.record");

  const rows = await db
    .select({
      receipt: paymentReceipts,
      customerName: customers.name,
      outstanding: customers.outstanding,
      reportedBy: sql<string | null>`(
        select u.name from users u where u.id = payment_receipts.reported_by_id
      )`,
      waitingHours: sql<number>`
        round(extract(epoch from (now() - payment_receipts.created_at)) / 3600)::int`,
    })
    .from(paymentReceipts)
    .innerJoin(customers, eq(customers.id, paymentReceipts.customerId))
    .where(eq(paymentReceipts.status, "reported"))
    .orderBy(asc(paymentReceipts.createdAt));

  if (!rows.length) return [];

  const lines = await db
    .select({
      receiptId: payments.receiptId,
      billId: payments.billId,
      billNo: bills.billNo,
      amount: payments.amount,
    })
    .from(payments)
    .leftJoin(bills, eq(bills.id, payments.billId))
    .where(
      inArray(
        payments.receiptId,
        rows.map((r) => r.receipt.id),
      ),
    );

  const byReceipt = new Map<string, PendingReceipt["lines"]>();
  for (const l of lines) {
    const list = byReceipt.get(l.receiptId) ?? [];
    list.push({ billId: l.billId, billNo: l.billNo, amount: Number(l.amount) });
    byReceipt.set(l.receiptId, list);
  }

  return rows.map(({ receipt: r, ...rest }) => ({
    receiptId: r.id,
    customerId: r.customerId,
    customerName: rest.customerName,
    amount: Number(r.amount),
    receivedAt: r.receivedAt,
    mode: r.mode,
    reference: r.reference,
    note: r.note,
    source: r.source,
    reportedBy: rest.reportedBy,
    reportedAt: r.createdAt.toISOString(),
    waitingHours: Number(rest.waitingHours ?? 0),
    lines: byReceipt.get(r.id) ?? [],
    outstanding: Number(rest.outstanding ?? 0),
  }));
}

export async function pendingReceiptCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentReceipts)
    .where(eq(paymentReceipts.status, "reported"));
  return Number(row?.n ?? 0);
}

/* ------------------------------------------------------- confirm and reject */

export async function confirmReceipt(
  receiptId: string,
): Promise<Result<{ receiptId: string; cleared: boolean }>> {
  const ctx = await requireCapability("payment.confirm");

  const [receipt] = await db
    .select()
    .from(paymentReceipts)
    .where(eq(paymentReceipts.id, receiptId));
  if (!receipt) return err("That receipt no longer exists.", "not_found");
  if (receipt.status !== "reported") {
    return err(
      receipt.status === "confirmed"
        ? "Somebody has already confirmed this one."
        : "That receipt was rejected. It cannot be confirmed without being recorded again.",
      "conflict",
    );
  }

  // The allocation was worked out when the money was reported, and the bills it
  // named may have been settled by something else since. Re-checking here would
  // silently move the money; refusing sends it back to a person, which is the
  // right answer for anything with financial consequences.
  const stale = await staleLines(receiptId);
  if (stale.length) {
    return err(
      `${stale.join(", ")} ${stale.length === 1 ? "has" : "have"} been settled since this was reported. Reject it and record the payment again against what is actually open.`,
      "conflict",
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(paymentReceipts)
      .set({
        status: "confirmed",
        confirmedById: ctx.user.id,
        confirmedAt: new Date(),
        updatedById: ctx.user.id,
        updatedAt: new Date(),
      })
      .where(eq(paymentReceipts.id, receiptId));
    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "payment.confirm",
      entityType: "payment_receipt",
      entityId: receiptId,
      beforeState: { status: "reported" } as never,
      afterState: { status: "confirmed", amount: receipt.amount } as never,
    });
  });

  await applyToLedger(receipt.customerId);

  const [customer] = await db
    .select({ outstanding: customers.outstanding, name: customers.name })
    .from(customers)
    .where(eq(customers.id, receipt.customerId));

  const cleared = Number(customer?.outstanding ?? 0) <= 0;
  return ok(
    { receiptId, cleared },
    cleared
      ? `${rupees(Number(receipt.amount))} confirmed — ${customer?.name} owes nothing`
      : `${rupees(Number(receipt.amount))} confirmed`,
  );
}

export async function rejectReceipt(
  receiptId: string,
  reason: string,
): Promise<Result<{ receiptId: string }>> {
  const ctx = await requireCapability("payment.confirm");

  if (!reason.trim()) {
    // The telecaller has to ring the customer back and say something. "Rejected"
    // on its own gives them nothing to say.
    return err("Say why the payment is being rejected.", "validation", [
      { field: "reason", message: "A reason is required." },
    ]);
  }

  const [receipt] = await db
    .select()
    .from(paymentReceipts)
    .where(eq(paymentReceipts.id, receiptId));
  if (!receipt) return err("That receipt no longer exists.", "not_found");
  if (receipt.status === "rejected") {
    return ok({ receiptId }, "Already rejected");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(paymentReceipts)
      .set({
        status: "rejected",
        rejectReason: reason.trim(),
        updatedById: ctx.user.id,
        updatedAt: new Date(),
      })
      .where(eq(paymentReceipts.id, receiptId));
    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "payment.reject",
      entityType: "payment_receipt",
      entityId: receiptId,
      beforeState: { status: receipt.status } as never,
      // The amount is recorded here, not left to be joined back later: the log
      // has to say what was rejected, and a receipt somebody later re-records
      // under a new id would leave this row describing nothing.
      afterState: {
        status: "rejected",
        reason: reason.trim(),
        amount: Number(receipt.amount),
      } as never,
    });
  });

  // A receipt that had been confirmed and is now rejected has to give the money
  // back to the bills it settled, which is exactly what a rebuild does.
  await applyToLedger(receipt.customerId);

  return ok({ receiptId }, `${rupees(Number(receipt.amount))} rejected`);
}

/** Bills a pending receipt names that no longer have room for its line. */
async function staleLines(receiptId: string): Promise<string[]> {
  const rows = await db
    .select({
      billNo: bills.billNo,
      amount: payments.amount,
      balance: sql<number>`(bills.amount - bills.paid_amount)::bigint`,
    })
    .from(payments)
    .innerJoin(bills, eq(bills.id, payments.billId))
    .where(eq(payments.receiptId, receiptId));

  return rows
    .filter((r) => Number(r.amount) > Number(r.balance))
    .map((r) => r.billNo);
}

/* --------------------------------------------------------- reported quiet */

export type ReportedQuiet = {
  customerId: string;
  amount: number;
  reportedOn: string;
};

/**
 * Customers with money reported against them and not yet decided on. The
 * collections cadence reads this to leave them alone — chasing somebody who
 * paid this morning is the fastest way to lose them — and the quiet expires,
 * so an unconfirmed claim cannot silence an account indefinitely.
 */
export async function reportedQuietByCustomer(): Promise<Map<string, ReportedQuiet>> {
  const rows = await db
    .select({
      customerId: paymentReceipts.customerId,
      amount: sql<number>`sum(payment_receipts.amount)::bigint`,
      reportedOn: sql<string>`max((payment_receipts.created_at at time zone 'Asia/Kolkata')::date)`,
    })
    .from(paymentReceipts)
    .where(eq(paymentReceipts.status, "reported"))
    .groupBy(paymentReceipts.customerId);

  return new Map(
    rows.map((r) => [
      r.customerId,
      {
        customerId: r.customerId,
        amount: Number(r.amount ?? 0),
        reportedOn: r.reportedOn,
      },
    ]),
  );
}

/* ------------------------------------------------------------------ search */

export type PaymentSearchHit = {
  customerId: string;
  customerName: string;
  /** Why this customer matched, shown under the name. */
  matchedOn: string;
  outstanding: number;
  openBills: number;
};

/**
 * One box over every way a payment names its customer: the customer, a bill
 * number, the order number the customer quotes down the phone, and the
 * reference on a receipt already recorded. All four land on the same answer —
 * a customer — because that is what the next screen needs.
 */
export async function paymentSearch(query: string): Promise<PaymentSearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const like = `%${q}%`;
  const digits = q.replace(/\D/g, "");

  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      outstanding: customers.outstanding,
      openBills: sql<number>`(
        select count(*) from bills b
         where b.customer_id = customers.id and b.amount > b.paid_amount
      )::int`,
      billMatch: sql<string | null>`(
        select b.bill_no from bills b
         where b.customer_id = customers.id and b.bill_no ilike ${like}
         limit 1
      )`,
      orderMatch: sql<string | null>`(
        select o.external_ref from orders o
         where o.customer_id = customers.id and o.external_ref ilike ${like}
         limit 1
      )`,
      referenceMatch: sql<string | null>`(
        select r.reference from payment_receipts r
         where r.customer_id = customers.id and r.reference ilike ${like}
         limit 1
      )`,
    })
    .from(customers)
    .where(
      and(
        ids ? inArray(ASSIGNED_TO_SQL, ids) : undefined,
        or(
          sql`${customers.name} ilike ${like}`,
          sql`${customers.contactPerson} ilike ${like}`,
          digits.length >= 4 ? sql`${customers.phone} like ${`%${digits}%`}` : undefined,
          sql`exists (select 1 from bills b where b.customer_id = customers.id and b.bill_no ilike ${like})`,
          sql`exists (select 1 from orders o where o.customer_id = customers.id and o.external_ref ilike ${like})`,
          sql`exists (select 1 from payment_receipts r where r.customer_id = customers.id and r.reference ilike ${like})`,
        ),
      ),
    )
    .orderBy(desc(customers.outstanding))
    .limit(12);

  return rows.map((r) => ({
    customerId: r.id,
    customerName: r.name,
    outstanding: Number(r.outstanding ?? 0),
    openBills: Number(r.openBills ?? 0),
    matchedOn: r.billMatch
      ? `Bill ${r.billMatch}`
      : r.orderMatch
        ? `Order ${r.orderMatch}`
        : r.referenceMatch
          ? `Reference ${r.referenceMatch}`
          : "Customer",
  }));
}

/* ------------------------------------------------------------------ ledger */

export type LedgerEntry = {
  at: string;
  kind: "bill" | "receipt";
  ref: string;
  detail: string;
  /** Paise added to what the customer owes. */
  debit: number;
  /** Paise taken off it. */
  credit: number;
  status: string | null;
  /** Running balance after this entry. Confirmed money only. */
  balance: number;
};

export type CustomerLedger = {
  customerId: string;
  customerName: string;
  openingBalance: number;
  entries: LedgerEntry[];
  totals: { billed: number; received: number; outstanding: number; onAccount: number };
  /** Reported but undecided — shown apart, because it is not money yet. */
  awaiting: { count: number; amount: number };
};

/**
 * A statement: what was billed, what came in, and what is left after each
 * line. Rejected receipts stay on it — a transfer that never landed is a fact
 * about the account, and dropping it leaves a telecaller wondering why the
 * balance did not move.
 *
 * The running balance counts confirmed money only, so it agrees with
 * `customers.outstanding` at the bottom. Anything still waiting on accounts is
 * reported separately rather than folded in.
 */
export async function customerLedger(
  customerId: string,
  range?: { from?: string; to?: string },
): Promise<CustomerLedger | null> {
  const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!customer) return null;
  await assertCustomerInScope(customer);

  const billRows = await db
    .select()
    .from(bills)
    .where(eq(bills.customerId, customerId))
    .orderBy(asc(bills.billDate));

  const receiptRows = await db
    .select({
      receipt: paymentReceipts,
      allocated: sql<number>`coalesce((
        select sum(p.amount) from payments p
         where p.receipt_id = payment_receipts.id and p.bill_id is not null
      ), 0)::bigint`,
    })
    .from(paymentReceipts)
    .where(eq(paymentReceipts.customerId, customerId))
    .orderBy(asc(paymentReceipts.receivedAt));

  type Row = Omit<LedgerEntry, "balance"> & { sort: string };
  const rows: Row[] = [];

  for (const b of billRows) {
    rows.push({
      at: b.billDate,
      sort: `${b.billDate}-0-${b.billNo}`,
      kind: "bill",
      ref: b.billNo,
      detail: b.disputed ? "Bill raised · disputed" : "Bill raised",
      debit: Number(b.amount),
      credit: 0,
      status: b.status,
    });
  }

  for (const { receipt: r, allocated } of receiptRows) {
    const onAccount = Number(r.amount) - Number(allocated);
    // The projection writes "Not stated" as a mode, meaning the sheet never
    // said how the money arrived. Printed raw it reads as a fault rather than
    // as a fact about the record, so it is turned into a sentence here.
    const parts = [r.mode === "Not stated" ? "Payment · method not recorded" : r.mode];
    if (r.reference) parts.push(r.reference);
    if (onAccount > 0) parts.push(`${rupees(onAccount)} on account`);
    if (r.status === "reported") parts.push("waiting for accounts");
    if (r.status === "rejected") parts.push(r.rejectReason ?? "rejected");
    rows.push({
      at: r.receivedAt,
      sort: `${r.receivedAt}-1-${r.id}`,
      kind: "receipt",
      // The reference column is for a reference. Where there is none, say so
      // rather than repeating the mode into it — "Not stated · Not stated"
      // across two columns looks like a broken row.
      ref: r.reference ?? (r.mode === "Not stated" ? "—" : r.mode),
      detail: parts.join(" · "),
      debit: 0,
      // Only confirmed money comes off the balance. A reported receipt shows on
      // the statement as a line worth nothing yet, which is what it is.
      credit: r.status === "confirmed" ? Number(r.amount) : 0,
      status: r.status,
    });
  }

  rows.sort((a, b) => a.sort.localeCompare(b.sort));

  const from = range?.from;
  const to = range?.to;
  let opening = 0;
  const entries: LedgerEntry[] = [];
  let balance = 0;

  for (const r of rows) {
    balance += r.debit - r.credit;
    if (from && r.at < from) {
      opening = balance;
      continue;
    }
    if (to && r.at > to) continue;
    const { sort: _sort, ...entry } = r;
    void _sort;
    entries.push({ ...entry, balance });
  }

  const shown = entries;
  const billed = shown.reduce((s, e) => s + e.debit, 0);
  const received = shown.reduce((s, e) => s + e.credit, 0);

  const awaitingRows = receiptRows.filter((r) => r.receipt.status === "reported");
  const onAccountTotal = receiptRows
    .filter((r) => r.receipt.status === "confirmed")
    .reduce((s, r) => s + (Number(r.receipt.amount) - Number(r.allocated)), 0);

  return {
    customerId,
    customerName: customer.name,
    openingBalance: opening,
    entries: shown,
    totals: {
      billed,
      received,
      outstanding: Number(customer.outstanding ?? 0),
      onAccount: onAccountTotal,
    },
    awaiting: {
      count: awaitingRows.length,
      amount: awaitingRows.reduce((s, r) => s + Number(r.receipt.amount), 0),
    },
  };
}

/** Money received and not yet spent against a bill. */
export async function onAccountBalance(customerId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(payments.amount), 0)::bigint` })
    .from(payments)
    .innerJoin(paymentReceipts, eq(paymentReceipts.id, payments.receiptId))
    .where(
      and(
        eq(payments.customerId, customerId),
        isNull(payments.billId),
        eq(paymentReceipts.status, "confirmed"),
      ),
    );
  return Number(row?.total ?? 0);
}
