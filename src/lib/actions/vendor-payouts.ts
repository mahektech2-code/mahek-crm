"use server";

import { revalidatePath } from "next/cache";
import { fromThrown, type Result } from "@/lib/result";
import {
  addPayoutInvoice,
  cancelPayout,
  createManualPayout,
  holdPayout,
  markPayoutPaid,
  releasePayout,
  removePayoutInvoice,
  reopenPayout,
  reschedulePayout,
  updatePayoutNotes,
  type InvoiceInput,
  type ManualPayoutInput,
} from "@/lib/services/vendor-payout-service";

/* ---------------------------------------------------------------------------
 * Writes for Accounts → Vendor payouts. Every one re-checks the screen and the
 * capability in the service: a server action is a URL, and a hidden button is
 * not a permission.
 * ------------------------------------------------------------------------- */

async function run<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    const res = await work();
    // The sidebar's overdue badge lives in the layout.
    if (res.ok) revalidatePath("/accounts", "layout");
    return res;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function createPayoutAction(input: ManualPayoutInput) {
  return run(() => createManualPayout(input));
}
export async function reschedulePayoutAction(payoutId: string, payOn: string) {
  return run(() => reschedulePayout(payoutId, payOn));
}
export async function holdPayoutAction(payoutId: string, reason: string) {
  return run(() => holdPayout(payoutId, reason));
}
export async function releasePayoutAction(payoutId: string) {
  return run(() => releasePayout(payoutId));
}
export async function markPayoutPaidAction(
  payoutId: string,
  input: { paidOn: string; amountPaise: number; mode: string; reference?: string | null },
) {
  return run(() => markPayoutPaid(payoutId, input));
}
export async function reopenPayoutAction(payoutId: string, reason: string) {
  return run(() => reopenPayout(payoutId, reason));
}
export async function cancelPayoutAction(payoutId: string, reason: string) {
  return run(() => cancelPayout(payoutId, reason));
}
export async function updatePayoutNotesAction(payoutId: string, notes: string) {
  return run(() => updatePayoutNotes(payoutId, notes));
}
export async function addPayoutInvoiceAction(payoutId: string, invoice: InvoiceInput) {
  return run(() => addPayoutInvoice(payoutId, invoice));
}
export async function removePayoutInvoiceAction(invoiceId: string) {
  return run(() => removePayoutInvoice(invoiceId));
}
