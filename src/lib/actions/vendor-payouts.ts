"use server";

import { revalidatePath } from "next/cache";
import { err, fromThrown, type Result } from "@/lib/result";
import { confirmImpact } from "@/lib/impact/registry";
import type { ImpactConfirmation } from "@/lib/impact/types";
import { accountsDeskRefusal, CASH_FLOW } from "@/lib/impact/kinds/accounts";
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
/*
 * Reopening, cancelling and taking an invoice off are confirmed against what
 * the person was shown — the payment record cleared, the calendar changed, the
 * file gone. The desk's own question comes first, in the service's words; the
 * reason is asked before the confirmation, as it always was.
 */
async function confirmed(
  capability: "payment.confirm" | "payment.record",
  kind: string,
  id: string,
  confirmation: ImpactConfirmation | undefined,
): Promise<Result<never> | null> {
  const closed = await accountsDeskRefusal("payouts", CASH_FLOW, capability);
  if (closed) return err(closed, "not_permitted");
  return confirmImpact(kind, id, confirmation);
}

export async function reopenPayoutAction(payoutId: string, reason: string, confirmation?: ImpactConfirmation) {
  return run(async () => {
    const refusal = reason.trim() ? await confirmed("payment.confirm", "accounts-payout-reopen", payoutId, confirmation) : null;
    return refusal ?? reopenPayout(payoutId, reason);
  });
}
export async function cancelPayoutAction(payoutId: string, reason: string, confirmation?: ImpactConfirmation) {
  return run(async () => {
    const refusal = reason.trim() ? await confirmed("payment.confirm", "accounts-payout-cancel", payoutId, confirmation) : null;
    return refusal ?? cancelPayout(payoutId, reason);
  });
}
export async function updatePayoutNotesAction(payoutId: string, notes: string) {
  return run(() => updatePayoutNotes(payoutId, notes));
}
export async function addPayoutInvoiceAction(payoutId: string, invoice: InvoiceInput) {
  return run(() => addPayoutInvoice(payoutId, invoice));
}
export async function removePayoutInvoiceAction(invoiceId: string, confirmation?: ImpactConfirmation) {
  return run(async () => (await confirmed("payment.record", "accounts-payout-invoice", invoiceId, confirmation)) ?? removePayoutInvoice(invoiceId));
}
