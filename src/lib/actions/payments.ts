"use server";

import { revalidatePath } from "next/cache";
import {
  confirmReceipt,
  recordReceipt,
  rejectReceipt,
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

export async function confirmReceiptAction(receiptId: string): Promise<Result> {
  try {
    const r = await confirmReceipt(receiptId);
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
