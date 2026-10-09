import "server-only";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  customers,
  erpBankLines,
  erpBankMatches,
  erpCashClosings,
  erpCustomerCashReceipts,
  erpExpenseAdjustments,
  erpExpenseCategories,
  erpExpensePayments,
  erpExpenses,
  erpFundAdjustments,
  erpFundTransfers,
  erpGodowns,
  erpTallySync,
} from "@/db/schema";
import { ageing, dueDateFor, payableState, type PayableState } from "../engines/petty-cash";
import { today } from "../screens/common";
import { pettyConfig } from "./core";

/* ---------------------------------------------------------------------------
 * Reading the module's records with everything derived beside them, once, so
 * the Expenses list, Vendor outstanding, the reports, the budgets and the
 * exception queue all say the same thing about one bill.
 * ------------------------------------------------------------------------- */

export type ExpenseRow = typeof erpExpenses.$inferSelect;
export type PaymentRow = typeof erpExpensePayments.$inferSelect;
export type AdjustmentRow = typeof erpExpenseAdjustments.$inferSelect;

export type ExpenseFact = {
  e: ExpenseRow;
  category: string | null;
  categoryRule: string | null;
  receiptRequired: boolean;
  godown: string;
  payments: PaymentRow[];
  adjustments: AdjustmentRow[];
  state: PayableState;
  due: string | null;
  daysOverdue: number;
  bucket: string;
  evidence: number;
  /** For an advance: what is still to be set against a bill or recovered. */
  advanceOpenPaise: number;
  /** Paid before it was approved. */
  urgent: boolean;
};

/** A real payable: submitted onward, received, not a legacy row, not withdrawn. */
export const isLive = (e: ExpenseRow) => !e.legacy && ["submitted", "under_review", "approved"].includes(e.approvalStatus);
/** A confirmed liability: approved and received (PRD §10 — drafts and commitments are not liabilities). */
export const isPayable = (e: ExpenseRow) => !e.legacy && e.approvalStatus === "approved" && e.incurred;

export async function loadExpenses(opts: { ids?: string[] } = {}): Promise<ExpenseFact[]> {
  const where = opts.ids ? inArray(erpExpenses.id, opts.ids.length ? opts.ids : ["-"]) : undefined;
  const [rows, payments, adjustments, evidence, recoveries] = await Promise.all([
    db
      .select({ e: erpExpenses, category: erpExpenseCategories.name, rule: erpExpenseCategories.approvalRule, receipt: erpExpenseCategories.receiptRequired, godown: erpGodowns.name })
      .from(erpExpenses)
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpExpenses.godownId))
      .leftJoin(erpExpenseCategories, eq(erpExpenseCategories.id, erpExpenses.categoryId))
      .where(where)
      .orderBy(desc(erpExpenses.expenseDate), desc(erpExpenses.createdAt)),
    db.select().from(erpExpensePayments).orderBy(asc(erpExpensePayments.paymentDate), asc(erpExpensePayments.createdAt)),
    db.select().from(erpExpenseAdjustments).orderBy(asc(erpExpenseAdjustments.requestedAt)),
    db.execute(sql`select record_id as id, count(*)::int as n from erp_petty_evidence where record_type = 'expense' group by record_id`) as unknown as Promise<{ id: string; n: number }[]>,
    db.select({ expenseId: erpFundAdjustments.expenseId, amount: erpFundAdjustments.amountPaise }).from(erpFundAdjustments).where(sql`${erpFundAdjustments.kind} = 'advance_recovery' and ${erpFundAdjustments.status} = 'approved'`),
  ]);
  const payBy = group(payments, (p) => p.expenseId);
  const adjBy = group(adjustments, (a) => a.expenseId);
  const appliedFrom = new Map<string, number>();
  for (const a of adjustments) if (a.kind === "advance_applied" && a.status === "approved" && a.advanceExpenseId) appliedFrom.set(a.advanceExpenseId, (appliedFrom.get(a.advanceExpenseId) ?? 0) + a.amountPaise);
  const recovered = new Map<string, number>();
  for (const r of recoveries) if (r.expenseId) recovered.set(r.expenseId, (recovered.get(r.expenseId) ?? 0) + r.amount);
  const evBy = new Map(evidence.map((x) => [x.id, Number(x.n)]));
  const day = today();
  const cfg = await pettyConfig();
  return rows.map((r) => {
    const ps = payBy.get(r.e.id) ?? [];
    const as = adjBy.get(r.e.id) ?? [];
    const state = payableState(r.e.amountPaise, ps, as, cfg.tolerancePaise);
    const due = r.e.legacy ? null : dueDateFor(r.e.dueDate, r.e.billDate ?? r.e.expenseDate, r.e.paymentTermsDays ?? 0);
    const a = ageing(due, day);
    return {
      e: r.e,
      category: r.category ?? r.e.category,
      categoryRule: r.rule,
      receiptRequired: r.receipt ?? false,
      godown: r.godown,
      payments: ps,
      adjustments: as,
      state,
      due,
      daysOverdue: state.outstandingPaise > 0 ? a.daysOverdue : 0,
      bucket: a.bucket,
      evidence: evBy.get(r.e.id) ?? 0,
      advanceOpenPaise: r.e.isAdvance ? Math.max(0, state.paidPaise - (appliedFrom.get(r.e.id) ?? 0) - (recovered.get(r.e.id) ?? 0)) : 0,
      urgent: ps.some((p) => p.approval === "urgent" && p.status === "confirmed"),
    };
  });
}

export async function loadExpense(id: string): Promise<ExpenseFact | null> {
  return (await loadExpenses({ ids: [id] }))[0] ?? null;
}

/** The label a payable's state reads as, beside its approval. */
export function payableWord(f: ExpenseFact): string {
  if (f.e.legacy) return f.e.status === "Verify" ? "Verified (before the ledger)" : "Pending (before the ledger)";
  if (!f.e.incurred) return "Commitment";
  return { PENDING: "Pending", PARTIALLY_PAID: "Partially paid", COMPLETED: "Completed", OVERPAID: "Overpaid" }[f.state.status];
}

export async function loadPayments() {
  return db
    .select({ p: erpExpensePayments, expenseCode: erpExpenses.code, particular: erpExpenses.particular, vendor: erpExpenses.vendorName, expenseAmount: erpExpenses.amountPaise, godownId: erpExpenses.godownId })
    .from(erpExpensePayments)
    .innerJoin(erpExpenses, eq(erpExpenses.id, erpExpensePayments.expenseId))
    .orderBy(desc(erpExpensePayments.paymentDate), desc(erpExpensePayments.createdAt));
}

export async function loadTransfers() {
  return db.select().from(erpFundTransfers).orderBy(desc(erpFundTransfers.transferDate), desc(erpFundTransfers.createdAt));
}

export async function loadReceipts() {
  return db
    .select({ r: erpCustomerCashReceipts, customer: customers.name })
    .from(erpCustomerCashReceipts)
    .innerJoin(customers, eq(customers.id, erpCustomerCashReceipts.customerId))
    .orderBy(desc(erpCustomerCashReceipts.receiptDate), desc(erpCustomerCashReceipts.createdAt));
}

/**
 * Where a customer's cash is now: held in the cash box, on its way, or
 * handed over / deposited — read off the transfers that carry it, never
 * stored, so a cancelled deposit puts it back in the box on its own.
 */
export function receiptCustody(receiptId: string, transfers: (typeof erpFundTransfers.$inferSelect)[]): { word: string; transferCode: string | null } {
  const t = transfers.filter((x) => x.linkedReceiptIds.includes(receiptId) && (x.status === "confirmed" || x.status === "initiated"));
  const done = t.find((x) => x.status === "confirmed");
  if (done) return { word: done.transferType === "customerDeposit" ? "Deposited" : "Handed over", transferCode: done.code };
  const moving = t.find((x) => x.status === "initiated");
  if (moving) return { word: "In transit", transferCode: moving.code };
  return { word: "Held", transferCode: null };
}

export async function loadClosings() {
  return db.select().from(erpCashClosings).orderBy(desc(erpCashClosings.closingDate));
}

export async function loadFundAdjustments() {
  return db.select().from(erpFundAdjustments).orderBy(desc(erpFundAdjustments.requestedAt));
}

export async function loadBankLines() {
  const [lines, matches] = await Promise.all([db.select().from(erpBankLines).orderBy(desc(erpBankLines.txnDate), asc(erpBankLines.createdAt)), db.select().from(erpBankMatches)]);
  return { lines, matches: group(matches, (m) => m.bankLineId) };
}

export async function tallyByRecord(): Promise<Map<string, typeof erpTallySync.$inferSelect>> {
  const rows = await db.select().from(erpTallySync);
  return new Map(rows.map((r) => [`${r.recordType}:${r.recordId}`, r]));
}

export const TALLY_WORD: Record<string, string> = {
  not_required: "Not required",
  pending: "Pending sync",
  syncing: "Syncing",
  posted: "Posted to Tally",
  failed: "Failed",
  correction: "Correction required",
  reversed: "Reversed in Tally",
};

export const RECON_WORD: Record<string, string> = {
  not_applicable: "Not a bank payment",
  unreconciled: "Awaiting bank statement",
  matched: "Matched",
  reconciled: "Reconciled",
};

export const BANK_WORD: Record<string, string> = {
  unmatched: "Unmatched",
  suggested: "Suggested match",
  matched: "Matched",
  reconciled: "Reconciled",
  exception: "Exception",
  correction: "Correction required",
};

export function group<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(key(r), [...(out.get(key(r)) ?? []), r]);
  return out;
}
