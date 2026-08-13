import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, bills, customers, paymentReceipts, payments } from "@/db/schema";
import {
  assertCustomerInScope,
  can,
  requireCapability,
  resolveScope,
  scopedUserIds, scopedToUsers,} from "../access-control";
import { getConfig } from "../config/store";
import { allocate, type AllocatableBill } from "../engines/allocation";
import {
  blocksSilentDuplicate,
  matchReceipts,
  type MatchCandidate,
  type MatchEntry,
  type ReceiptMatch,
} from "../engines/receipt-match";
import { effectiveDueDate } from "../engines/escalation";
import { billCreditDaysSql } from "../bill-terms";
import { daysBetween } from "../business-date";
import {
  recomputeBillPaid,
  recomputeBillStatuses,
  recomputeFollowUpState,
  recomputeOutstanding,
  today,
} from "../recompute";
import { bindAttachments } from "./attachment-service";
import { err, ok, okVoid, type Result } from "../result";
import { CRM_EVENT, writeTimelineEvents } from "../timeline";
import { money } from "../format";

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
  /**
   * Paise claimed against this bill by receipts nobody has confirmed — reported
   * AND held. A hold is still somebody claiming this money settles this bill;
   * leaving it out would show a bill as unclaimed while a person in accounts is
   * actively looking for the very payment against it.
   */
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
         where p.bill_id = bills.id and r.status in ('reported','held')
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
  /** The date on the cheque. Past or future are both ordinary. */
  instrumentDate: z.string().trim().optional(),
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
  status: "reported" | "held" | "confirmed";
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

  /*
   * A cheque without its date is a cheque nobody can act on.
   *
   * Asked of EVERYBODY, unlike the reference. The reasoning that exempts a
   * telecaller from supplying a UTR does not carry across: a customer who says
   * they have paid by cheque is holding the cheque, and "what date is on it" is
   * a question that can be asked on the same call. Without it, accounts cannot
   * tell a cheque due to be banked this morning from one dated next month, and
   * the customer cannot be spared a chase they do not deserve.
   */
  const dated = config["payments.datedModes"].includes(input.mode);
  if (dated && !input.instrumentDate) {
    return err(`A ${input.mode.toLowerCase()} needs the date written on it.`, "validation", [
      {
        field: "instrumentDate",
        message: "Enter the date on the instrument — it may be past or future.",
      },
    ]);
  }
  // Deliberately no bound in either direction. A post-dated cheque is the
  // ordinary case, and a stale-dated one is exactly the kind that goes quiet
  // in a drawer until somebody notices.
  if (!dated && input.instrumentDate) {
    return err(`A ${input.mode.toLowerCase()} does not carry a date of its own.`, "validation", [
      { field: "instrumentDate", message: "Leave this blank for this mode." },
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
        // The status it actually has. Flattening a held receipt to "reported"
        // here would tell a retried save the wrong thing about its own money.
        status:
          dupe.status === "confirmed"
            ? "confirmed"
            : dupe.status === "held"
              ? "held"
              : "reported",
        allocated: 0,
        onAccount: 0,
        billsTouched: 0,
      },
      "Already recorded",
    );
  }

  const open = await openBillsFor(input.customerId);
  /*
   * A BILL OFFERS ITS WHOLE UNCONFIRMED BALANCE, and money somebody has merely
   * reported against it does not reduce that.
   *
   * It used to. `paid + reported` was subtracted so that two people writing
   * down one transfer could not over-credit an account — a real failure, and
   * the reasoning was sound when it was the only guard there was. What it also
   * did was make a bill with a reported payment against it look settled: zero
   * available, nothing to allocate to, and accounts unable to record the money
   * they were holding the statement for. The customer still owed it — nothing
   * unconfirmed ever touched `paid_amount` — so the ledger and the entry
   * screen disagreed about the same bill, and the screen was the one people
   * were working from.
   *
   * The duplicate is now caught where it actually happens: `matchesForEntry`
   * asks "is this the same money somebody already wrote down?" at the moment
   * of entry, and an exact or reference match has to be answered before a
   * second receipt can be saved. That is a better place for it in every way —
   * it asks a person a question they can answer, instead of silently making a
   * bill unavailable and leaving them to work out why.
   *
   * What is claimed is still carried on the row, and every screen shows it.
   */
  const allocatable: AllocatableBill[] = open.map((b) => ({
    id: b.id,
    billNo: b.billNo,
    billDate: b.billDate,
    amount: b.amount,
    paid: b.paid,
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
      instrumentDate: input.instrumentDate || null,
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

    // §1.1 — into the shared stream, in the same transaction. Whether the
    // business has SEEN the money is the whole difference between these two
    // sentences, so the status is in the words rather than implied.
    await writeTimelineEvents(tx, [
      {
        customerId: input.customerId,
        eventType: CRM_EVENT.payment,
        sourceApp: "crm",
        sourceRecordId: receiptId,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: confirms
          ? `${money(input.amount)} received by ${input.mode.toLowerCase()} — confirmed by accounts`
          : `${money(input.amount)} reported by ${input.mode.toLowerCase()} — awaiting confirmation by accounts`,
      },
    ]);

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
  /*
   * A bill that money recorded in the APP has touched is a bill somebody has
   * spoken for. Two marks, both set here rather than at each call site,
   * because every route to confirmed money passes through this function and a
   * decision recorded in three places is a decision missed in one:
   *
   *   `payment_decided_at` — when it was decided. Only ever set once, so it
   *   keeps saying WHEN rather than drifting to the latest touch.
   *
   *   `payment_position`   — that it has been stated at all. Unconditional,
   *   because a bill can be `unstated` while already carrying a decided
   *   timestamp from before this column existed, and the whole point is that
   *   `unstated` means nobody has said. Recording money against it IS saying.
   *
   * `source <> 'sheet_import'` is what keeps the two apart: a receipt the
   * spreadsheet wrote is not somebody deciding, which is the entire subject of
   * this change.
   */
  await db.execute(sql`
    update bills set
      payment_decided_at = coalesce(bills.payment_decided_at, now()),
      payment_position = 'stated'
    where bills.id in (
        select p.bill_id from payments p
        join payment_receipts r on r.id = p.receipt_id
        where r.customer_id = ${customerId}
          and r.source <> 'sheet_import'
          and p.bill_id is not null
      )
      and (bills.payment_decided_at is null or bills.payment_position <> 'stated')`);

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

  /* ------------------------------------------------- a dated instrument */
  /** The date written on the cheque. Null on modes that carry no date. */
  instrumentDate: string | null;
  /**
   * The cheque is dated today or earlier, so it can be banked — which means
   * somebody should be looking for it on the statement now. A post-dated one
   * is not asking for anything yet, and must not be flagged as though it were.
   */
  bankableNow: boolean;
  /** Days since it became bankable. Negative while still post-dated. */
  bankableDays: number | null;
  /** What it would settle, if confirmed. */
  lines: Array<{ billId: string | null; billNo: string | null; amount: number }>;
  /** The customer's whole open balance, for context. */
  outstanding: number;

  /* ------------------------------------------------------------ the hold */
  status: "reported" | "held";
  heldByName: string | null;
  holdReason: string | null;
  /** Whole days since it was parked. Null on anything not held. */
  heldDays: number | null;
  /**
   * Past `payments.holdStaleDays`. A hold never expires, so this flag is the
   * whole of what stops one being forgotten — and the customer behind it has
   * been getting no calls and no messages for every one of those days.
   */
  holdStale: boolean;
};

/**
 * Everything waiting on accounts, longest wait first.
 *
 * HELD RECEIPTS ARE ON THIS LIST, not filtered off it. A hold is work in
 * progress rather than work finished: somebody is part-way through finding the
 * money in a bank statement, and the customer is silent on collections until
 * they finish. Hiding held rows would make the list look shorter and the
 * customer disappear from both screens at once, which is the exact failure the
 * held-back strips in the CRM exist to prevent.
 */
export async function pendingReceipts(): Promise<PendingReceipt[]> {
  await requireCapability("payment.record");
  const config = await getConfig();
  const day = await today();

  const rows = await db
    .select({
      receipt: paymentReceipts,
      customerName: customers.name,
      outstanding: customers.outstanding,
      reportedBy: sql<string | null>`(
        select u.name from users u where u.id = payment_receipts.reported_by_id
      )`,
      heldByName: sql<string | null>`(
        select u.name from users u where u.id = payment_receipts.held_by_id
      )`,
      waitingHours: sql<number>`
        round(extract(epoch from (now() - payment_receipts.created_at)) / 3600)::int`,
      // Whole days on hold, in the business's own zone. A bare subtraction
      // against `now()` answers in the server's, and Neon runs in GMT.
      heldDays: sql<number | null>`case when payment_receipts.held_at is null then null else
        ((now() at time zone 'Asia/Kolkata')::date
         - (payment_receipts.held_at at time zone 'Asia/Kolkata')::date) end`,
    })
    .from(paymentReceipts)
    .innerJoin(customers, eq(customers.id, paymentReceipts.customerId))
    .where(inArray(paymentReceipts.status, ["reported", "held"]))
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
    instrumentDate: r.instrumentDate,
    bankableNow: Boolean(r.instrumentDate && r.instrumentDate <= day),
    bankableDays: r.instrumentDate ? daysBetween(r.instrumentDate, day) : null,
    status: r.status === "held" ? "held" : "reported",
    heldByName: rest.heldByName ?? null,
    holdReason: r.holdReason,
    heldDays: rest.heldDays === null ? null : Number(rest.heldDays),
    holdStale:
      rest.heldDays !== null &&
      Number(rest.heldDays) >= config["payments.holdStaleDays"],
  }));
}

export async function pendingReceiptCount(): Promise<number> {
  // Held rows are counted too. The badge says how much money accounts have
  // still to decide on, and a hold is undecided — leaving it out would let a
  // queue of holds read as an empty desk.
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentReceipts)
    .where(inArray(paymentReceipts.status, ["reported", "held"]));
  return Number(row?.n ?? 0);
}

/* ------------------------------------------------------------------- hold */

/**
 * Park a payment while accounts look for it in the bank statement.
 *
 * The customer comes OFF collections entirely — no calls, no reminder messages
 * — and stays off until somebody decides. That is the point: we are part-way
 * through establishing whether their money arrived, and chasing them through
 * it is worse than any call not made.
 *
 * The quiet does not expire, which is deliberately unlike a bare report. A
 * report is an unanswered claim and its quiet has to lapse, or a customer
 * could silence their own account for good by saying they had paid. A hold is
 * a named person's judgement, and the thing that keeps it honest is that it
 * ages in plain sight on accounts' own list rather than lapsing behind their
 * back.
 */
export async function holdReceipt(
  receiptId: string,
  reason: string,
): Promise<Result<{ receiptId: string }>> {
  const ctx = await requireCapability("payment.confirm");

  if (!reason.trim()) {
    /*
     * Required, for the same reason declining an order is.
     *
     * A hold takes the customer off the collections list, so the telecaller
     * who was chasing them stops hearing about them — and when the customer
     * rings to ask why nobody has been in touch, "the system says they are on
     * hold" is not an answer anybody can give down a phone.
     */
    return err("Say what is being checked.", "validation", [
      { field: "reason", message: "A reason is required." },
    ]);
  }

  const [receipt] = await db
    .select()
    .from(paymentReceipts)
    .where(eq(paymentReceipts.id, receiptId));
  if (!receipt) return err("That receipt no longer exists.", "not_found");

  if (receipt.status === "held") return ok({ receiptId }, "Already on hold");
  if (receipt.status !== "reported") {
    return err(
      receipt.status === "confirmed"
        ? "That payment has already been confirmed. Reverse it if it turned out not to be money."
        : "That payment has already been decided. It cannot be put on hold now.",
      "conflict",
    );
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(paymentReceipts)
      .set({
        status: "held",
        heldById: ctx.user.id,
        heldAt: now,
        holdReason: reason.trim(),
        updatedById: ctx.user.id,
        updatedAt: now,
      })
      .where(eq(paymentReceipts.id, receiptId));

    // §1.1 — the telecaller's own screens read this stream, and this is the
    // event that explains a customer going quiet on their worklist.
    await writeTimelineEvents(tx, [
      {
        customerId: receipt.customerId,
        eventType: CRM_EVENT.payment,
        // The shared stream knows two apps. Accounts writes as `crm` because
        // that is the book this event belongs to — the telecaller's customer
        // timeline is where it has to be readable.
        sourceApp: "crm",
        sourceRecordId: receiptId,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: `${money(Number(receipt.amount))} put on hold by accounts — ${reason.trim()}`,
      },
    ]);

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "payment.hold",
      entityType: "payment_receipt",
      entityId: receiptId,
      beforeState: { status: receipt.status } as never,
      afterState: {
        status: "held",
        reason: reason.trim(),
        amount: Number(receipt.amount),
      } as never,
    });
  });

  // Nothing about the money changed — a hold counts no more than a report did
  // — but the collections state has to be rebuilt, because the customer is now
  // held off the worklist and their row on it should go at once.
  await recomputeFollowUpState(receipt.customerId);

  return ok(
    { receiptId },
    `${rupees(Number(receipt.amount))} on hold — ${await customerName(receipt.customerId)} will not be chased until you decide`,
  );
}

async function customerName(customerId: string): Promise<string> {
  const [row] = await db
    .select({ name: customers.name })
    .from(customers)
    .where(eq(customers.id, customerId));
  return row?.name ?? "the customer";
}

/* ------------------------------------------------------- confirm and reject */

/**
 * How the money should be split when it is confirmed.
 *
 * Omitted means keep the allocation the receipt already carries, which is what
 * confirming has always meant. Supplied means accounts looked at it and
 * decided differently — the same three instructions the record form offers,
 * run through the same pure engine, so the preview in the drawer and the write
 * on the server cannot disagree about where the money went.
 */
export type ConfirmAllocation = {
  mode: "auto" | "settle" | "custom";
  selectedBillIds?: string[];
  custom?: Record<string, number>;
};

export async function confirmReceipt(
  receiptId: string,
  allocation?: ConfirmAllocation,
): Promise<Result<{ receiptId: string; cleared: boolean }>> {
  const ctx = await requireCapability("payment.confirm");
  const config = await getConfig();

  const [receipt] = await db
    .select()
    .from(paymentReceipts)
    .where(eq(paymentReceipts.id, receiptId));
  if (!receipt) return err("That receipt no longer exists.", "not_found");
  // A held receipt is confirmable: holding is a pause in the middle of this
  // decision, not a different decision.
  if (receipt.status !== "reported" && receipt.status !== "held") {
    return err(
      receipt.status === "confirmed"
        ? "Somebody has already confirmed this one."
        : "That receipt was rejected. It cannot be confirmed without being recorded again.",
      "conflict",
    );
  }

  /*
   * Where accounts have RE-POINTED the money, the lines are rewritten before
   * anything is confirmed.
   *
   * This is also the way out of a dead end. The allocation was worked out when
   * the money was reported, and a bill it named may have been settled by
   * something else since; that used to refuse the confirmation outright and
   * leave rejecting-and-re-recording as the only path — which loses the
   * telecaller's claim, the date it was made and the reference, to fix a
   * problem that is only about which bill. Re-pointing it is the honest fix,
   * and it is still a person deciding rather than the code moving money on its
   * own.
   */
  if (allocation) {
    const redone = await reallocate(receipt, allocation, config);
    if (!redone.ok) return redone;
  } else {
    const stale = await staleLines(receiptId);
    if (stale.length) {
      return err(
        `${stale.join(", ")} ${stale.length === 1 ? "has" : "have"} been settled since this was reported. Change what it settles, or reject it and record the payment again.`,
        "conflict",
      );
    }
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
      // The status it actually came from. `reported` was hardcoded here, which
      // would now record a hold of nine days as though nobody had touched it.
      beforeState: {
        status: receipt.status,
        holdReason: receipt.holdReason,
      } as never,
      afterState: {
        status: "confirmed",
        amount: receipt.amount,
        reallocated: Boolean(allocation),
      } as never,
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

/**
 * Taking back money that counted.
 *
 * A cheque clears and then bounces. The same transfer is entered twice. A
 * receipt is applied to the wrong customer and both accounts are wrong until
 * somebody says so. All of these are ordinary, and until now the only way to
 * express any of them was `rejected` — which is a different fact and says so
 * on the statement: "never arrived". A customer who paid, and whose payment
 * later failed, must not be told on the one document they might dispute that
 * their money was never seen.
 *
 * So it is its own status. Nothing else had to be taught about it: every money
 * path in the app keys on `confirmed`, so a receipt that stops being confirmed
 * stops counting everywhere at once — `paid_amount`, outstanding, the aging
 * strip, the collections worklist, the slow-payer flag.
 *
 * WHAT IT DOES NOT DO IS DELETE. The row keeps its amount, its reference and
 * its date, gains a reason, and stays on the customer's statement. A payment
 * that arrived and was taken back is a fact about the account — dropping it
 * leaves the next person wondering why the balance moved twice.
 *
 * ONLY A CONFIRMED RECEIPT CAN BE REVERSED. A reported one has not counted
 * yet, so there is nothing to take back and `rejectReceipt` is the honest
 * answer; being strict here is what keeps the two words meaning different
 * things a year from now.
 */
export async function reverseReceipt(
  receiptId: string,
  reason: string,
): Promise<Result<{ receiptId: string }>> {
  // The same capability as confirming, and for the same reason: accounts hold
  // the bank statement, and taking money back off an account is the same kind
  // of decision as putting it on.
  const ctx = await requireCapability("payment.confirm");

  if (!reason.trim()) {
    // Somebody has to ring the customer and say something, and "reversed" on
    // its own gives them nothing to say. It also lands on the statement.
    return err("Say why the payment is being reversed.", "validation", [
      { field: "reason", message: "A reason is required." },
    ]);
  }

  const [receipt] = await db
    .select()
    .from(paymentReceipts)
    .where(eq(paymentReceipts.id, receiptId));
  if (!receipt) return err("That receipt no longer exists.", "not_found");

  if (receipt.status === "reversed") return ok({ receiptId }, "Already reversed");
  if (receipt.status === "rejected") {
    return err("That payment was already rejected — it never counted.", "validation");
  }
  if (receipt.status !== "confirmed") {
    return err(
      "Only a confirmed payment can be reversed. Reject it instead — it has not counted yet.",
      "validation",
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(paymentReceipts)
      .set({
        status: "reversed",
        // The same column rejection uses: one place a receipt says why it is
        // not money, whichever way it stopped being money.
        rejectReason: reason.trim(),
        updatedById: ctx.user.id,
        updatedAt: new Date(),
      })
      .where(eq(paymentReceipts.id, receiptId));

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "payment.reverse",
      entityType: "payment_receipt",
      entityId: receiptId,
      beforeState: { status: receipt.status } as never,
      // The amount is written here rather than joined back later, exactly as
      // rejection does: the log has to say what was taken back on its own.
      afterState: {
        status: "reversed",
        reason: reason.trim(),
        amount: Number(receipt.amount),
      } as never,
    });
  });

  // Giving the money back to the bills it settled is a rebuild, never a
  // subtraction — which is what makes confirming, reversing and re-recording
  // all land on the same answer.
  await applyToLedger(receipt.customerId);

  return ok({ receiptId }, `${rupees(Number(receipt.amount))} reversed`);
}

/**
 * Rewrite where a not-yet-confirmed receipt's money goes.
 *
 * Runs the SAME pure engine the record form runs, against what is open right
 * now, so the preview accounts read in the drawer is the arithmetic that gets
 * written. Only the lines of this receipt are replaced — the receipt's amount,
 * date, reference and who reported it are untouched, because none of those are
 * accounts' to change from a review screen.
 *
 * `paid + reported` is what a bill offers, minus THIS receipt's own claim on
 * it: without that subtraction a receipt re-pointed at the bill it already
 * names would find its own money in the way and refuse to fit.
 */
async function reallocate(
  receipt: { id: string; customerId: string; amount: number; receivedAt: string; mode: string; reference: string | null },
  allocation: ConfirmAllocation,
  config: Awaited<ReturnType<typeof getConfig>>,
): Promise<Result<void>> {
  const ctx = await requireCapability("payment.confirm");
  const open = await openBillsFor(receipt.customerId);

  const ownLines = await db
    .select({ billId: payments.billId, amount: payments.amount })
    .from(payments)
    .where(eq(payments.receiptId, receipt.id));
  const own = new Map<string, number>();
  for (const l of ownLines) {
    if (l.billId) own.set(l.billId, (own.get(l.billId) ?? 0) + Number(l.amount));
  }

  // The whole unconfirmed balance, exactly as `recordReceipt` offers it — the
  // claim other undecided receipts have on a bill is shown, never subtracted.
  const allocatable: AllocatableBill[] = open.map((b) => ({
    id: b.id,
    billNo: b.billNo,
    billDate: b.billDate,
    amount: b.amount,
    paid: b.paid,
  }));

  const result = allocate(allocatable, {
    mode: allocation.mode,
    amount: Number(receipt.amount),
    selectedBillIds: allocation.selectedBillIds ?? [],
    custom: allocation.custom ?? {},
    allowOnAccount: config["payments.allowOnAccountRemainder"],
  });
  if (result.errors.length) {
    return err(result.errors[0], "validation", [
      { field: "allocation", message: result.errors.join(" ") },
    ]);
  }

  await db.transaction(async (tx) => {
    await tx.delete(payments).where(eq(payments.receiptId, receipt.id));
    for (const line of result.lines) {
      await tx.insert(payments).values({
        id: id("pay"),
        receiptId: receipt.id,
        billId: line.billId,
        customerId: receipt.customerId,
        amount: line.amount,
        paidAt: receipt.receivedAt,
        mode: receipt.mode,
        reference: receipt.reference,
        // Keyed on the receipt and the bill, so re-pointing twice cannot leave
        // two lines claiming the same money against the same bill.
        externalRef: `${receipt.id}:realloc:${line.billId ?? "on-account"}`,
        recordedById: ctx.user.id,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
    }

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "payment.reallocate",
      entityType: "payment_receipt",
      entityId: receipt.id,
      beforeState: { lines: ownLines } as never,
      afterState: { mode: allocation.mode, lines: result.lines } as never,
    });
  });

  return okVoid();
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
  /** True where ANY of this customer's undecided money is on hold. */
  held: boolean;
  /** The reason on the oldest hold, for the sentence the telecaller reads. */
  holdReason: string | null;
  /** The latest date on an undecided cheque, where any of them carries one. */
  postDatedTo: string | null;
};

/**
 * Customers with money reported against them and not yet decided on. The
 * collections cadence reads this to leave them alone — chasing somebody who
 * paid this morning is the fastest way to lose them.
 *
 * Two kinds of quiet come out of one query, and which it is matters. A bare
 * report is an unanswered claim, and its quiet EXPIRES so that nobody can
 * silence their own account by making one. A hold is somebody in accounts
 * deciding to look for the money, and its quiet does not expire — see
 * `reportedQuiet` in the follow-up engine, which is the one place that
 * difference is applied.
 *
 * A customer with both is treated as held. The strongest reason to leave
 * somebody alone is the one that should win, and a hold is a person saying so.
 */
export async function reportedQuietByCustomer(): Promise<Map<string, ReportedQuiet>> {
  const rows = await db
    .select({
      customerId: paymentReceipts.customerId,
      amount: sql<number>`sum(payment_receipts.amount)::bigint`,
      reportedOn: sql<string>`max((payment_receipts.created_at at time zone 'Asia/Kolkata')::date)`,
      held: sql<boolean>`bool_or(payment_receipts.status = 'held')`,
      // The oldest hold's reason: the one that has been keeping them quiet
      // longest is the one worth naming.
      holdReason: sql<string | null>`(
        array_agg(payment_receipts.hold_reason order by payment_receipts.held_at asc nulls last)
        filter (where payment_receipts.status = 'held')
      )[1]`,
      // The LATEST of them. Two cheques dated a fortnight apart mean the
      // customer is not finished paying until the second one can be banked,
      // and taking the earlier would put them back on the list in between.
      postDatedTo: sql<string | null>`max(payment_receipts.instrument_date)`,
    })
    .from(paymentReceipts)
    .where(inArray(paymentReceipts.status, ["reported", "held"]))
    .groupBy(paymentReceipts.customerId);

  return new Map(
    rows.map((r) => [
      r.customerId,
      {
        customerId: r.customerId,
        amount: Number(r.amount ?? 0),
        reportedOn: r.reportedOn,
        held: Boolean(r.held),
        holdReason: r.holdReason ?? null,
        postDatedTo: r.postDatedTo ?? null,
      },
    ]),
  );
}

/* ------------------------------------------- money we already know about */

/**
 * Undecided receipts on this customer, for the matcher.
 *
 * Only `reported` and `held`. Confirmed money is already in the ledger and
 * offering it as a match would invite somebody to confirm it twice; rejected
 * and reversed money is a decision already taken, and re-opening it from a
 * data-entry screen is not what that screen is for.
 */
export async function matchCandidatesFor(
  customerId: string,
): Promise<MatchCandidate[]> {
  const rows = await db
    .select({
      receipt: paymentReceipts,
      reportedByName: sql<string | null>`(
        select u.name from users u where u.id = payment_receipts.reported_by_id
      )`,
      reportedOn: sql<string>`(payment_receipts.created_at at time zone 'Asia/Kolkata')::date`,
    })
    .from(paymentReceipts)
    .where(
      and(
        eq(paymentReceipts.customerId, customerId),
        inArray(paymentReceipts.status, ["reported", "held"]),
      ),
    )
    .orderBy(asc(paymentReceipts.createdAt));

  return rows.map(({ receipt: r, ...rest }) => ({
    receiptId: r.id,
    amount: Number(r.amount),
    receivedAt: r.receivedAt,
    mode: r.mode,
    reference: r.reference,
    status: r.status === "held" ? ("held" as const) : ("reported" as const),
    reportedByName: rest.reportedByName ?? null,
    reportedOn: rest.reportedOn,
    note: r.holdReason ?? r.note,
  }));
}

export type ReceiptMatchView = ReceiptMatch & {
  /** Whether recording a NEW receipt alongside this should take a deliberate act. */
  blocking: boolean;
};

/**
 * What accounts should be shown before they record a payment from the bank
 * statement: money somebody has already written down that looks like this
 * money.
 *
 * The telecaller hears about a payment on the phone days before the transfer
 * appears on a statement. Both records are honest and both describe one
 * payment; entered separately, the customer is credited twice and somebody
 * untangles it months later against a customer who is certain they paid once.
 */
export async function matchesForEntry(
  customerId: string,
  entry: MatchEntry,
): Promise<ReceiptMatchView[]> {
  await requireCapability("payment.record");
  const config = await getConfig();

  const matches = matchReceipts(await matchCandidatesFor(customerId), entry, {
    matchWindowDays: config["payments.matchWindowDays"],
    matchTolerancePercent: config["payments.matchTolerancePercent"],
  });

  return matches.map((m) => ({ ...m, blocking: blocksSilentDuplicate(m) }));
}

/**
 * The bank entry IS the money somebody already reported.
 *
 * Confirms the receipt that already exists rather than writing a second one —
 * which is the entire point, because two rows for one payment is the failure
 * this is here to prevent. What accounts know that the telecaller did not is
 * written onto it on the way past: the reference off the statement, the day it
 * actually landed, and where the money should go.
 *
 * The typed confirmation is checked HERE and not only in the dialog. Merging
 * two records of money is not a thing to do on a stray click, and a check that
 * lives only in the interface is not a check.
 */
export async function confirmAsMatch(input: {
  receiptId: string;
  /** Paise, as the accounts user typed it back. Must equal the receipt. */
  confirmAmount: number;
  /** From the bank statement, where the reported receipt had none. */
  reference?: string;
  receivedAt?: string;
  mode?: string;
  allocation?: ConfirmAllocation;
}): Promise<Result<{ receiptId: string; cleared: boolean }>> {
  const ctx = await requireCapability("payment.confirm");

  const [receipt] = await db
    .select()
    .from(paymentReceipts)
    .where(eq(paymentReceipts.id, input.receiptId));
  if (!receipt) return err("That receipt no longer exists.", "not_found");
  if (receipt.status !== "reported" && receipt.status !== "held") {
    return err(
      receipt.status === "confirmed"
        ? "Somebody has already confirmed that one — this money is in the ledger."
        : "That receipt has already been decided.",
      "conflict",
    );
  }

  if (input.confirmAmount !== Number(receipt.amount)) {
    return err(
      `That is not the amount on the payment being confirmed. Type ${rupees(Number(receipt.amount))} to confirm it.`,
      "validation",
      [{ field: "confirmAmount", message: "The amount does not match." }],
    );
  }

  /*
   * What accounts saw is written over what was taken down a phone.
   *
   * Only where they actually supplied it: a blank reference on the form must
   * not wipe one the telecaller managed to get. The AMOUNT is deliberately not
   * touched — a different amount is a different payment, and this path exists
   * only for the case where the two are the same money.
   */
  const patch: Record<string, unknown> = { updatedById: ctx.user.id, updatedAt: new Date() };
  if (input.reference?.trim()) patch.reference = input.reference.trim();
  if (input.receivedAt) patch.receivedAt = input.receivedAt;
  if (input.mode) patch.mode = input.mode;

  if (Object.keys(patch).length > 2) {
    await db
      .update(paymentReceipts)
      .set(patch)
      .where(eq(paymentReceipts.id, input.receiptId));
  }

  await db.insert(auditLog).values({
    id: id("aud"),
    actorId: ctx.user.id,
    action: "payment.matchedToBankEntry",
    entityType: "payment_receipt",
    entityId: input.receiptId,
    beforeState: {
      status: receipt.status,
      reference: receipt.reference,
      receivedAt: receipt.receivedAt,
    } as never,
    // The second receipt that WAS NOT written is the fact worth recording:
    // without this line, the account shows one payment and nothing says a
    // person decided it was one payment rather than two.
    afterState: {
      reference: patch.reference ?? receipt.reference,
      receivedAt: patch.receivedAt ?? receipt.receivedAt,
      duplicateAvoided: true,
    } as never,
  });

  return confirmReceipt(input.receiptId, input.allocation);
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
        scopedToUsers(ids),
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
  /** Set on receipt lines only — what a reversal acts on. */
  receiptId?: string;
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
 * The one thing a statement leaves out.
 *
 * A reversed receipt normally belongs on a statement, and emphatically so: a
 * cheque that cleared and bounced is a fact about the account, and the customer
 * may well dispute the balance against this document. These are different. The
 * 9,370 receipts this excludes were never payments — they were written by an
 * earlier sheet import which assumed every bill was settled on the day it was
 * raised, and `scripts/tally-receipts.ts` reversed them when Tally's registers
 * said what had actually arrived. Nothing happened on those dates. Nobody's
 * money moved and nobody made a decision.
 *
 * Printing them puts 967 red "reversed" rows on one customer's statement and
 * some on 513 of them, each implying a payment that failed. That is not
 * history, it is an artifact of a bug wearing history's clothes — and it is
 * worse than a gap, because a reader has no way to tell it from the real
 * reversals sitting beside it.
 *
 * They are HIDDEN rather than deleted. The rows are the only record of what the
 * book used to claim and the only way to check or undo that migration, so they
 * stay where the audit log and the revert script can still find them. The mark
 * is `updated_by_id`, which only that script writes; the eighteen reversals a
 * person made by hand carry somebody's user id instead and still print.
 */
const NOT_ON_STATEMENT = sql`not (
  ${paymentReceipts.source} = 'sheet_import'
  and ${paymentReceipts.status} = 'reversed'
  and ${paymentReceipts.updatedById} = 'system:tally-records'
)`;

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
    .where(and(eq(paymentReceipts.customerId, customerId), NOT_ON_STATEMENT))
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
    // Said in its own words. "Never arrived" would be wrong about a cheque
    // that cleared and then bounced, and this is the document a customer
    // disputes a balance against.
    if (r.status === "reversed") parts.push(`reversed — ${r.rejectReason ?? "no reason recorded"}`);
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
      // Carried so the statement can act on the line somebody is looking at.
      // Reversing a payment starts with finding it, and this is where anybody
      // looking for one already is.
      receiptId: r.id,
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
