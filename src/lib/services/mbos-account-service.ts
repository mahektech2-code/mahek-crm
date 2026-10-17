import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  bills,
  complaints,
  customers,
  followUpStates,
  paymentReceipts,
  payments,
  users,
} from "@/db/schema";
import { getConfig } from "../config/store";
import { today } from "../recompute";
import { bucketise } from "./accounts-home-service";
import { accountServing } from "./distributor-service";
import { billLines, type BillLine, type MbosPrincipal } from "./mbos-service";
import { listBills } from "./payment-service";
import {
  ledgerForCustomer,
  NOT_ON_STATEMENT,
  receiptStatusSentence,
} from "./receipt-service";

/* ---------------------------------------------------------------------------
 * A CUSTOMER'S WHOLE ACCOUNT, for the salesman's handset — the Accounts app's
 * customer account, read-only, over the device token.
 *
 * The handset already carries a statement on the customer record, built from
 * a thirteen-month window of bills and receipts that the pull keeps on the
 * phone so it works with no signal. That stays, and is what this screen falls
 * back to offline. What it cannot answer is everything ELSE Accounts sees
 * about one account: the full history rather than a window, receipts that are
 * held or were reversed and why, which bills each payment settled, money on
 * account, the aging strip, credit notes, the follow-up stage, and how the
 * account is served. A salesman asked "why does your office say I owe this"
 * needs exactly that, so it is asked for here when he opens it.
 *
 * NOT ONE FIGURE IS COMPUTED HERE THAT ACCOUNTS COMPUTES ELSEWHERE.
 * The statement is `ledgerForCustomer` — the body of `customerLedger`, which
 * is what `/accounts/ledger` draws. Bills are `listBills`, whose due dates,
 * overdue days and buckets are the ones every Accounts screen reads. The
 * aging strip is `bucketise` over the same rows the Bills screen hands it.
 * Receipt wording is `receiptStatusSentence`. A second copy of any of these
 * on a phone is how a salesman and an accounts clerk quote one shopkeeper two
 * different debts with him listening.
 *
 * SCOPE is the caller's, and it is the principal's — `scopedCustomer` has
 * already refused a shop outside his book before this runs, exactly as the
 * order-products route does. Everything below reads ONE customer id, so
 * nothing here can widen past that answer.
 *
 * It WRITES nothing and offers no action. Reversing, confirming, re-pointing
 * and issuing are accounts' decisions; the salesman sees them, he does not
 * take them.
 * ------------------------------------------------------------------------- */

export type HandsetAccount = Awaited<ReturnType<typeof handsetCustomerAccount>>;

export async function handsetCustomerAccount(principal: MbosPrincipal, customerId: string) {
  const [customer] = await db
    .select({
      id: customers.id,
      name: customers.name,
      kind: customers.kind,
      thirdParty: customers.thirdParty,
      city: customers.city,
      phone: customers.phone,
      gstin: customers.gstin,
      outstanding: customers.outstanding,
      creditLimitPaise: customers.creditLimitPaise,
      creditDays: customers.creditDays,
      creditBlocked: customers.creditBlocked,
      creditBlockReason: customers.creditBlockReason,
      slowPayer: customers.slowPayer,
      lastOrderDate: customers.lastOrderDate,
      salesPersonName: customers.salesPersonName,
      backOfficeName: customers.backOfficeName,
    })
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!customer) return null;

  const config = await getConfig();
  const [asOf, ledger, billRows, serving, [followUp], receiptRows, allocations, notes] =
    await Promise.all([
      today(),
      ledgerForCustomer(customer),
      /* The account, not the book: `scopedCustomer` has already said this shop
         is his, and the statement beside it reads every bill on the account.
         Narrowing this read by seat again would drop the bills of a shop he
         holds by NAME only (`namedByUsers`) — a statement with bills on it and
         a Bills tab without them, for one account on one screen. */
      listBills({ customerId }, { ...principal, scope: { kind: "all", userIds: null } }),
      accountServing(customerId),
      db.select().from(followUpStates).where(eq(followUpStates.customerId, customerId)),
      db
        .select({
          r: paymentReceipts,
          reportedBy: sql<string | null>`(select u.name from users u where u.id = payment_receipts.reported_by_id)`,
          confirmedBy: sql<string | null>`(select u.name from users u where u.id = payment_receipts.confirmed_by_id)`,
        })
        .from(paymentReceipts)
        .where(and(eq(paymentReceipts.customerId, customerId), NOT_ON_STATEMENT))
        .orderBy(desc(paymentReceipts.receivedAt), desc(paymentReceipts.id)),
      db
        .select({
          receiptId: payments.receiptId,
          billId: payments.billId,
          billNo: bills.billNo,
          amount: payments.amount,
        })
        .from(payments)
        .leftJoin(bills, eq(bills.id, payments.billId))
        .where(eq(payments.customerId, customerId))
        .orderBy(asc(payments.paidAt)),
      db
        .select({
          id: complaints.id,
          at: complaints.createdAt,
          category: complaints.category,
          description: complaints.description,
          amount: complaints.cnAmount,
          status: complaints.cnStatus,
          reference: complaints.cnReference,
          cnDate: complaints.cnDate,
          billNo: bills.billNo,
          raisedBy: users.name,
        })
        .from(complaints)
        .leftJoin(bills, eq(bills.id, complaints.billId))
        .leftJoin(users, eq(users.id, complaints.loggedByUserId))
        .where(and(eq(complaints.customerId, customerId), eq(complaints.requestCn, true)))
        .orderBy(desc(complaints.createdAt)),
    ]);

  const receiptById = new Map(receiptRows.map(({ r }) => [r.id, r]));

  /* Which receipts landed on which bill, and which bills each receipt
     settled. One read, folded both ways, so the bill sheet and the receipt
     sheet cannot disagree about one allocation line. */
  const byReceipt = new Map<string, { billNo: string | null; amountPaise: number }[]>();
  const byBill = new Map<
    string,
    { receiptId: string; at: string; amountPaise: number; mode: string; status: string }[]
  >();
  for (const a of allocations) {
    const r = receiptById.get(a.receiptId);
    if (!r) continue;
    const list = byReceipt.get(a.receiptId) ?? [];
    list.push({ billNo: a.billNo, amountPaise: Number(a.amount) });
    byReceipt.set(a.receiptId, list);
    if (a.billId) {
      const onBill = byBill.get(a.billId) ?? [];
      onBill.push({
        receiptId: r.id,
        at: r.receivedAt,
        amountPaise: Number(a.amount),
        mode: r.mode,
        status: r.status,
      });
      byBill.set(a.billId, onBill);
    }
  }

  const claimedByBillNo = new Map<string, number>();
  for (const e of ledger.entries) {
    if (e.kind === "bill" && e.claimed) claimedByBillNo.set(e.ref, e.claimed);
  }

  const lines = await billLines(billRows.map((b) => b.id));

  /* What is OPEN and spoken for — the same set the Bills screen hands
     `bucketise`. An `unstated` bill is not debt and is counted apart. */
  const open = billRows.filter((b) => b.balance > 0 && b.paymentPosition === "stated");
  const unstated = billRows.filter((b) => b.paymentPosition === "unstated");
  const aging = bucketise(
    open.map((b) => ({ overdueDays: b.overdueDays, balance: b.balance })),
    config["bills.agingBuckets"],
  );

  return {
    asOf,
    customer: {
      id: customer.id,
      name: customer.name,
      kind: customer.kind,
      thirdParty: customer.thirdParty,
      city: customer.city,
      phone: customer.phone,
      gstin: customer.gstin,
      outstandingPaise: Number(customer.outstanding ?? 0),
      creditLimitPaise: customer.creditLimitPaise == null ? null : Number(customer.creditLimitPaise),
      /* The configured default where the account names none, flagged so the
         screen can say which it is rather than present a default as agreed. */
      creditDays: customer.creditDays ?? config["bills.defaultCreditDays"],
      creditDaysIsDefault: customer.creditDays == null,
      creditBlocked: customer.creditBlocked,
      creditBlockReason: customer.creditBlockReason,
      slowPayer: customer.slowPayer,
      lastOrderDate: customer.lastOrderDate,
      salesPersonName: customer.salesPersonName,
      backOfficeName: customer.backOfficeName,
    },
    followUp: followUp
      ? {
          stage: followUp.stage,
          daysOverdue: followUp.daysOverdue,
          totalOverduePaise: Number(followUp.totalOverdue),
          overdueBillCount: followUp.overdueBillCount,
          oldestOverdueBillDate: followUp.oldestOverdueBillDate,
          held: followUp.held,
          heldReason: followUp.heldReason,
        }
      : null,
    serving: {
      thirdParty: serving.thirdParty,
      distributors: serving.distributors.map((d) => ({ name: d.name, isPrimary: d.isPrimary })),
      shops: serving.shops,
    },
    /* Oldest first, as the server computes it — the running balance only
       means anything in that order. The screen reverses for reading. */
    ledger: {
      onAccountPaise: ledger.totals.onAccount,
      awaitingCount: ledger.awaiting.count,
      awaitingPaise: ledger.awaiting.amount,
      entries: ledger.entries.map((e) => ({
        at: e.at,
        kind: e.kind,
        ref: e.ref,
        detail: e.detail,
        debitPaise: e.debit,
        creditPaise: e.credit,
        status: e.status,
        claimedPaise: e.claimed ?? 0,
        receiptId: e.receiptId ?? null,
        balancePaise: e.balance,
      })),
    },
    aging: {
      totalPaise: aging.total,
      bills: aging.bills,
      buckets: aging.buckets.map((b) => ({ label: b.label, from: b.from, amountPaise: b.amount })),
    },
    unstated: {
      count: unstated.length,
      amountPaise: unstated.reduce((s, b) => s + b.amount, 0),
    },
    /* Newest first: a bill list is read from the top. */
    bills: billRows.map((b) => ({
      id: b.id,
      billNo: b.billNo,
      billDate: b.billDate,
      dueDate: b.dueDate,
      amountPaise: b.amount,
      paidPaise: b.paid,
      balancePaise: b.balance,
      overdueDays: b.overdueDays,
      bucket: b.bucket,
      status: b.status,
      disputed: b.disputed,
      paymentPosition: b.paymentPosition,
      claimedPaise: claimedByBillNo.get(b.billNo) ?? 0,
      lines: (lines.get(b.id) ?? []) as BillLine[],
      payments: byBill.get(b.id) ?? [],
    })),
    receipts: receiptRows.map(({ r, reportedBy, confirmedBy }) => {
      const allocated = (byReceipt.get(r.id) ?? [])
        .filter((a) => a.billNo)
        .reduce((s, a) => s + a.amountPaise, 0);
      return {
        id: r.id,
        receiptNo: r.receiptNo,
        receivedAt: r.receivedAt,
        instrumentDate: r.instrumentDate,
        amountPaise: Number(r.amount),
        mode: r.mode,
        reference: r.reference,
        status: r.status,
        source: r.source,
        note: r.note,
        sentence: receiptStatusSentence({
          mode: r.mode,
          reference: r.reference,
          amount: Number(r.amount),
          allocated,
          status: r.status,
          rejectReason: r.rejectReason,
        }),
        allocations: (byReceipt.get(r.id) ?? []).filter((a) => a.billNo),
        /* Only confirmed money is on account; a claim nobody has found is
           not sitting anywhere yet. */
        onAccountPaise: r.status === "confirmed" ? Math.max(0, Number(r.amount) - allocated) : 0,
        reportedBy,
        confirmedBy,
        confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
        holdReason: r.holdReason,
        rejectReason: r.rejectReason,
      };
    }),
    creditNotes: notes.map((n) => ({
      id: n.id,
      at: n.at instanceof Date ? n.at.toISOString() : String(n.at),
      category: n.category,
      description: n.description,
      amountPaise: n.amount == null ? null : Number(n.amount),
      status: n.status ?? "requested",
      reference: n.reference,
      cnDate: n.cnDate,
      billNo: n.billNo,
      raisedBy: n.raisedBy,
    })),
  };
}
