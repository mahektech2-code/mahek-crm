import "server-only";
import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "@/db";
import { bills, payments, paymentReceipts } from "@/db/schema";
import { parseReceivables } from "../receivables-parse";
import { recomputeAllBillPaid, recomputeAllFollowUpStates, recomputeAllOutstanding, recomputeBillStatuses, recomputeSlowPayers } from "../recompute";

/* ---------------------------------------------------------------------------
 * Applying Tally's receivables to bills the order sheet said were paid.
 *
 * The order sheet carries no payment status, so every bill it produces is
 * imported settled. This report is the correction: the 371 bills that are in
 * fact still owed. Applying it is subtraction, not invention — a bill named
 * here has its assumed receipt reduced by what is pending, and everything not
 * named keeps the paid position it was imported with.
 *
 * Three rules it will not bend:
 *
 *   IT ONLY EVER UNPAYS. A bill absent from the report is untouched, because
 *   this file is a list of what is owed and says nothing at all about the rest.
 *   It cannot mark anything paid, so running it can never hide a debt.
 *
 *   A REFERENCE IT CANNOT FIND IS REPORTED, NEVER GUESSED. Tally numbers from
 *   before the order sheet's range, and bills raised since it was last synced,
 *   have no row here to correct — and picking a near match would move money
 *   against the wrong customer.
 *
 *   CREDITS ARE NOT APPLIED. Advances and unapplied receipts name no bill, so
 *   there is nothing to apply them to without guessing which debt they settle.
 * ------------------------------------------------------------------------- */

export type ReceivablesReport = {
  /** Bills matched by their exact number. */
  matched: number;
  /**
   * References that turned out to be one Tally bill split across several
   * orders, and the bills they were spread over, oldest first.
   */
  splitGroups: number;
  splitBills: number;
  /** Bills whose paid position actually changed. */
  updated: number;
  /** Due dates filled in from the report, where the bill had none. */
  dueDatesSet: number;
  /** Total still owed after this is applied, in paise. */
  pendingPaise: number;
  /** References with no bill behind them, listed so somebody can look. */
  unmatched: Array<{ reference: string; customer: string; pendingPaise: number }>;
  /** Money against no bill: advances, unapplied receipts, credit notes. */
  credits: number;
  creditsPaise: number;
  problems: string[];
  dryRun: boolean;
};

/**
 * Reduces one bill's settled position to leave `pending` owing.
 *
 * Paid is derived from confirmed receipts, so this edits the receipt rather
 * than the bill: the allocation is cut to what was really received, and a bill
 * owed in full loses its assumed receipt altogether. Writing `paid_amount`
 * directly would make this a second author of a cached figure that already has
 * one, and the next recompute would undo it.
 */
async function leaveOwing(billId: string, amount: number, pending: number) {
  const settled = Math.max(0, amount - pending);

  // The mark of a decision, written FIRST and whatever else happens below.
  // Deleting the assumed receipt frees the `SHEETPAY-<order number>` key, and
  // a free key reads to the importer as "never settled" — which is how the 9
  // August run was undone by a cron fourteen hours later. This is what tells
  // the importer to keep its hands off: from here the bill's paid position is
  // somebody's decision, and only the app may change it.
  // `paymentPosition` too: the report naming this bill IS somebody stating its
  // position, which is exactly what lifts it out of `unstated` and into the
  // outstanding figure, the aging strip and the collections worklist. A bill
  // Tally says is owed is a debt a person has vouched for.
  await db
    .update(bills)
    .set({
      paymentDecidedAt: new Date(),
      paymentPosition: "stated",
      updatedAt: new Date(),
    })
    .where(eq(bills.id, billId));

  const rows = await db
    .select({ paymentId: payments.id, receiptId: payments.receiptId })
    .from(payments)
    .innerJoin(paymentReceipts, eq(paymentReceipts.id, payments.receiptId))
    .where(and(eq(payments.billId, billId), eq(paymentReceipts.source, "sheet_import")));

  // Marked even where there was no assumed receipt to cut: the report naming a
  // bill IS the decision, and a bill it names must never be settled by
  // assumption later.
  if (!rows.length) return false;

  for (const r of rows) {
    if (settled <= 0) {
      // Nothing was received, so the assumed receipt describes nothing.
      await db.delete(payments).where(eq(payments.id, r.paymentId));
      await db.delete(paymentReceipts).where(eq(paymentReceipts.id, r.receiptId));
    } else {
      await db.update(payments).set({ amount: settled }).where(eq(payments.id, r.paymentId));
      await db
        .update(paymentReceipts)
        .set({ amount: settled, updatedAt: new Date() })
        .where(eq(paymentReceipts.id, r.receiptId));
    }
  }
  return true;
}

export async function applyReceivables(
  text: string,
  options: { dryRun?: boolean } = {},
): Promise<ReceivablesReport> {
  const parsed = parseReceivables(text);
  const dryRun = options.dryRun ?? false;

  const report: ReceivablesReport = {
    matched: 0,
    splitGroups: 0,
    splitBills: 0,
    updated: 0,
    dueDatesSet: 0,
    pendingPaise: 0,
    unmatched: [],
    credits: parsed.credits.length,
    creditsPaise: parsed.credits.reduce((a, c) => a + c.pendingPaise, 0),
    problems: parsed.problems,
    dryRun,
  };

  const references = [...new Set(parsed.rows.map((r) => r.reference))];
  const exact = references.length
    ? await db
        .select({ id: bills.id, billNo: bills.billNo, amount: bills.amount, dueDate: bills.dueDate })
        .from(bills)
        .where(inArray(bills.billNo, references))
    : [];
  const byNo = new Map(exact.map((b) => [b.billNo, b]));

  for (const row of parsed.rows) {
    report.pendingPaise += row.pendingPaise;

    const direct = byNo.get(row.reference);
    if (direct) {
      report.matched++;
      if (!dryRun) {
        if (await leaveOwing(direct.id, direct.amount, row.pendingPaise)) report.updated++;
        if (row.dueDate && !direct.dueDate) {
          await db.update(bills).set({ dueDate: row.dueDate }).where(eq(bills.id, direct.id));
          report.dueDatesSet++;
        }
      } else {
        report.updated++;
        if (row.dueDate && !direct.dueDate) report.dueDatesSet++;
      }
      continue;
    }

    // One Tally bill can cover several orders, and the import made one bill
    // per order — `MMI/26-27/0718` became `.../0718/8590`, `/8591`, `/8592`.
    // The debt is against the Tally bill as a whole, so it is spread over the
    // group oldest first, exactly as a real payment would be applied.
    const group = await db
      .select({ id: bills.id, billNo: bills.billNo, amount: bills.amount, dueDate: bills.dueDate })
      .from(bills)
      .where(like(bills.billNo, `${row.reference}/%`))
      .orderBy(bills.billDate, bills.billNo);

    if (!group.length) {
      report.unmatched.push({
        reference: row.reference,
        customer: row.customer,
        pendingPaise: row.pendingPaise,
      });
      continue;
    }

    report.splitGroups++;
    report.splitBills += group.length;

    let left = row.pendingPaise;
    for (const b of group) {
      const owing = Math.min(left, b.amount);
      left -= owing;
      if (!dryRun) {
        if (await leaveOwing(b.id, b.amount, owing)) report.updated++;
        if (row.dueDate && !b.dueDate) {
          await db.update(bills).set({ dueDate: row.dueDate }).where(eq(bills.id, b.id));
          report.dueDatesSet++;
        }
      } else {
        report.updated++;
      }
      if (left <= 0) break;
    }
  }

  if (!dryRun) {
    // Everything downstream is a cache over what just changed.
    await recomputeAllBillPaid();
    await recomputeBillStatuses();
    await recomputeAllOutstanding();
    await recomputeAllFollowUpStates();
    await recomputeSlowPayers();
  }

  return report;
}

