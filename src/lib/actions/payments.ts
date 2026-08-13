"use server";

import { revalidatePath } from "next/cache";
import {
  confirmAsMatch,
  confirmReceipt,
  holdReceipt,
  matchesForEntry,
  recordReceipt,
  rejectReceipt,
  reverseReceipt,
  type ConfirmAllocation,
  type ReceiptMatchView,
  type RecordReceiptInput,
} from "@/lib/services/receipt-service";
import { fromThrown, type Result } from "@/lib/result";

/**
 * Thin over the service, which owns the capability checks. Whether a receipt
 * is believed on the way in, and who may confirm one afterwards, are decided
 * there — a disabled button is a courtesy, not a permission.
 */
function refresh() {
  try {
    // Money moving touches the accounts queue, the collections screens and
    // every place outstanding is shown.
    revalidatePath("/accounts/payments");
    revalidatePath("/accounts/record");
    revalidatePath("/accounts/ledger");
    revalidatePath("/apps");
    revalidatePath("/crm/payments");
    revalidatePath("/crm/bills");
    revalidatePath("/crm/dashboard");
    revalidatePath("/crm/customers/[id]", "page");
  } catch {
    /* no request context — nothing cached to invalidate */
  }
}

export async function recordReceiptAction(
  input: RecordReceiptInput,
): Promise<Result<{ receiptId: string; status: string; onAccount: number }>> {
  try {
    const r = await recordReceipt(input);
    if (r.ok) refresh();
    return r.ok
      ? {
          ...r,
          data: {
            receiptId: r.data.receiptId,
            status: r.data.status,
            onAccount: r.data.onAccount,
          },
        }
      : r;
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * `allocation` is what accounts changed in the review drawer, and omitting it
 * keeps whatever the receipt already carries — which is what confirming has
 * always meant, so every existing caller behaves exactly as before.
 */
export async function confirmReceiptAction(
  receiptId: string,
  allocation?: ConfirmAllocation,
): Promise<Result> {
  try {
    const r = await confirmReceipt(receiptId, allocation);
    if (r.ok) refresh();
    return r.ok ? { ok: true, data: undefined, message: r.message } : r;
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Park it while accounts look for the money in the bank statement.
 *
 * The customer comes off the collections worklist entirely — no calls, no
 * reminder messages — and stays off until this is approved or rejected. The
 * reason is required by the service, not just by the form: a telecaller whose
 * customer has gone quiet needs to be able to read why.
 */
export async function holdReceiptAction(
  receiptId: string,
  reason: string,
): Promise<Result> {
  try {
    const r = await holdReceipt(receiptId, reason);
    if (r.ok) refresh();
    return r.ok ? { ok: true, data: undefined, message: r.message } : r;
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * What somebody has already written down that looks like the money being
 * entered from the bank statement.
 *
 * A read, deliberately shaped as an action rather than an endpoint: it is
 * asked once, from a form, about one customer, and it carries a capability
 * check with it.
 */
export async function matchesForEntryAction(
  customerId: string,
  entry: { amount: number; receivedAt: string; mode: string; reference: string | null },
): Promise<Result<ReceiptMatchView[]>> {
  try {
    return { ok: true, data: await matchesForEntry(customerId, entry) };
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * The bank entry IS money somebody already reported — confirm that one rather
 * than writing a second.
 *
 * `confirmAmount` is the amount typed back by the person doing it, checked in
 * the service against the receipt. Merging two records of money is not a thing
 * to do on a stray click, and a check that lives only in the dialog is not a
 * check.
 */
export async function confirmAsMatchAction(input: {
  receiptId: string;
  confirmAmount: number;
  reference?: string;
  receivedAt?: string;
  mode?: string;
  allocation?: ConfirmAllocation;
}): Promise<Result> {
  try {
    const r = await confirmAsMatch(input);
    if (r.ok) refresh();
    return r.ok ? { ok: true, data: undefined, message: r.message } : r;
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Taking back money that had counted.
 *
 * Separate from rejection on purpose — see `reverseReceipt`. A rejected
 * payment never arrived; a reversed one arrived and then failed, and the two
 * read differently on a statement somebody may have to defend to a customer.
 */
export async function reverseReceiptAction(
  receiptId: string,
  reason: string,
): Promise<Result> {
  try {
    const r = await reverseReceipt(receiptId, reason);
    if (r.ok) refresh();
    return r.ok ? { ok: true, data: undefined, message: r.message } : r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function rejectReceiptAction(
  receiptId: string,
  reason: string,
): Promise<Result> {
  try {
    const r = await rejectReceipt(receiptId, reason);
    if (r.ok) refresh();
    return r.ok ? { ok: true, data: undefined, message: r.message } : r;
  } catch (e) {
    return fromThrown(e);
  }
}
