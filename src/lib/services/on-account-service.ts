import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, bills, customers, paymentReceipts, payments } from "@/db/schema";
import { requireCapability } from "../access-control";
import { getConfig } from "../config/store";
import { effectiveDueDate } from "../engines/escalation";
import { billCreditDaysSql } from "../bill-terms";
import {
  recomputeBillPaid,
  recomputeBillStatuses,
  recomputeFollowUpState,
  recomputeOutstanding,
} from "../recompute";
import { err, ok, type Result } from "../result";

/* ---------------------------------------------------------------------------
 * Money on account.
 *
 * A payment line with no bill against it. Real, confirmed money that is simply
 * not pointed at anything yet — a round-figure transfer against an awkward
 * balance, or money sent before the bill existed.
 *
 * It was created and consumed silently: `allocate()` makes these lines, and
 * nothing listed them, so a customer could carry a credit for months while
 * appearing on the collections worklist for a bill that credit would have
 * settled. This is the screen that shows them, and the one action worth
 * having — point it at the oldest open bill.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

const rupees = (paise: number) =>
  `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;

export type OnAccountHolder = {
  customerId: string;
  customerName: string;
  /** Paise sitting unallocated on confirmed receipts. */
  amount: number;
  /** What they still owe, from the derived cache. */
  outstanding: number;
  /** The bill applying it would settle first, where there is one. */
  oldestOpenBillId: string | null;
  oldestOpenBillNo: string | null;
  oldestOpenBalance: number;
  /** How many receipts the credit is spread across. */
  receipts: number;
};

export async function onAccountHolders(): Promise<OnAccountHolder[]> {
  await requireCapability("payment.record");

  const rows = await db.execute<{
    customer_id: string;
    customer_name: string;
    amount: number;
    outstanding: number;
    receipts: number;
    bill_id: string | null;
    bill_no: string | null;
    bill_balance: number;
  }>(sql`
    with credit as (
      select p.customer_id,
             sum(p.amount)::bigint as amount,
             count(distinct p.receipt_id)::int as receipts
        from payments p
        join payment_receipts r on r.id = p.receipt_id
       where p.bill_id is null and r.status = 'confirmed'
       group by p.customer_id
      having sum(p.amount) > 0
    ),
    oldest as (
      select distinct on (b.customer_id)
             b.customer_id, b.id as bill_id, b.bill_no,
             (b.amount - b.paid_amount)::bigint as balance
        from bills b
       where b.amount > b.paid_amount
       order by b.customer_id, b.bill_date asc, b.bill_no asc
    )
    select credit.customer_id, c.name as customer_name, credit.amount,
           c.outstanding, credit.receipts,
           oldest.bill_id, oldest.bill_no,
           coalesce(oldest.balance, 0) as bill_balance
      from credit
      join customers c on c.id = credit.customer_id
      left join oldest on oldest.customer_id = credit.customer_id
     order by credit.amount desc
  `);

  return rows.map((r) => ({
    customerId: r.customer_id,
    customerName: r.customer_name,
    amount: Number(r.amount ?? 0),
    outstanding: Number(r.outstanding ?? 0),
    receipts: Number(r.receipts ?? 0),
    oldestOpenBillId: r.bill_id,
    oldestOpenBillNo: r.bill_no,
    oldestOpenBalance: Number(r.bill_balance ?? 0),
  }));
}

/**
 * Point a customer's credit at their oldest open bill.
 *
 * The line is moved, not duplicated: the same money that arrived is now said
 * to have settled something. Where the credit is larger than the bill the line
 * is SPLIT — part against the bill, the remainder still on account — because
 * over-applying a line would make the bill read as paid twice.
 *
 * Nothing here writes `bills.paid_amount`. It rewrites the allocation and then
 * asks `recomputeBillPaid` to rebuild the figure from confirmed lines, which
 * is what makes applying, and any later rejection of the receipt, land on the
 * same answer.
 */
export async function applyOnAccount(
  customerId: string,
): Promise<Result<{ applied: number; billNo: string }>> {
  const ctx = await requireCapability("payment.confirm");
  const config = await getConfig();

  const [customer] = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!customer) return err("That customer no longer exists.", "not_found");

  // The credit, oldest arrival first — money sent longest ago is spent first.
  const lines = await db
    .select({
      id: payments.id,
      receiptId: payments.receiptId,
      amount: payments.amount,
      paidAt: payments.paidAt,
      mode: payments.mode,
    })
    .from(payments)
    .innerJoin(paymentReceipts, eq(paymentReceipts.id, payments.receiptId))
    .where(
      and(
        eq(payments.customerId, customerId),
        isNull(payments.billId),
        eq(paymentReceipts.status, "confirmed"),
      ),
    )
    .orderBy(asc(payments.paidAt), asc(payments.id));

  const credit = lines.reduce((sum, l) => sum + Number(l.amount), 0);
  if (credit <= 0) {
    return err(`${customer.name} is not holding anything on account.`, "conflict");
  }

  const [bill] = await db
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
    .where(and(eq(bills.customerId, customerId), sql`bills.amount > bills.paid_amount`))
    .orderBy(asc(bills.billDate), asc(bills.billNo))
    .limit(1);

  if (!bill) {
    return err(
      `${customer.name} has nothing open to apply it to. It stays on account and is offered against their next bill.`,
      "conflict",
    );
  }

  const balance = Number(bill.amount) - Number(bill.paid);
  const applied = Math.min(credit, balance);
  // Read only so the audit row can say which due date was in force.
  const due = effectiveDueDate(
    {
      id: bill.id,
      billNo: bill.billNo,
      billDate: bill.billDate,
      dueDate: bill.dueDate,
      creditDays: bill.creditDays === null ? null : Number(bill.creditDays),
      amount: Number(bill.amount),
      paid: Number(bill.paid),
      disputed: bill.disputed,
    },
    config,
  );

  await db.transaction(async (tx) => {
    let left = applied;
    for (const line of lines) {
      if (left <= 0) break;
      const value = Number(line.amount);
      if (value <= left) {
        // The whole line goes against the bill.
        await tx.update(payments).set({ billId: bill.id }).where(eq(payments.id, line.id));
        left -= value;
      } else {
        // Part of it does. The rest stays on account as its own line.
        await tx
          .update(payments)
          .set({ amount: left, billId: bill.id })
          .where(eq(payments.id, line.id));
        await tx.insert(payments).values({
          id: id("pay"),
          // The remainder belongs to the same arrival of money, so it keeps
          // the receipt it came in on rather than becoming a second one.
          receiptId: line.receiptId,
          billId: null,
          customerId,
          amount: value - left,
          paidAt: line.paidAt,
          mode: line.mode,
          externalRef: `split:${line.id}`,
          recordedById: ctx.user.id,
          createdById: ctx.user.id,
          updatedById: ctx.user.id,
        });
        left = 0;
      }
    }

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      action: "payment.apply_on_account",
      entityType: "bill",
      entityId: bill.id,
      afterState: {
        amount: applied,
        billNo: bill.billNo,
        dueDate: due,
        customerId,
      } as never,
    });
  });

  await recomputeBillPaid(customerId);
  await recomputeBillStatuses();
  await recomputeOutstanding(customerId);
  await recomputeFollowUpState(customerId);

  return ok(
    { applied, billNo: bill.billNo },
    `${rupees(applied)} applied to ${bill.billNo}`,
  );
}
