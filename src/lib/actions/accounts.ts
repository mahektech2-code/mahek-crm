"use server";

import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/access-control";
import {
  issueCreditNote,
  refuseCreditNote,
} from "@/lib/services/credit-note-service";
import { applyOnAccount } from "@/lib/services/on-account-service";
import { fromThrown, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * Writes for the Accounts app's own screens.
 *
 * Order approval and receipt confirmation already have theirs in
 * `actions/orders.ts` and `actions/payments.ts`. This file holds the three the
 * new screens added: issuing a credit note, refusing one, and pointing money
 * on account at a bill.
 *
 * Every one of them returns the shared Result rather than throwing, and every
 * one re-checks its capability in the service — a disabled button is a
 * courtesy, not a permission.
 * ------------------------------------------------------------------------- */

/** Both queues, the ledger and today's figures all move when one of these lands. */
function refreshAccounts() {
  revalidatePath("/accounts", "layout");
}

export async function issueCreditNoteAction(input: {
  complaintId: string;
  amount: number;
  reference?: string;
}): Promise<Result<{ receiptId: string }>> {
  try {
    const result = await issueCreditNote(input);
    if (result.ok) refreshAccounts();
    return result;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function refuseCreditNoteAction(
  complaintId: string,
  reason: string,
): Promise<Result> {
  try {
    const result = await refuseCreditNote(complaintId, reason);
    if (result.ok) refreshAccounts();
    return result;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function applyOnAccountAction(
  customerId: string,
): Promise<Result<{ applied: number; billNo: string }>> {
  try {
    const result = await applyOnAccount(customerId);
    if (result.ok) refreshAccounts();
    return result;
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Run the bill import.
 *
 * `owner` is required and cannot be defaulted: the sheet's only ownership
 * column names a sales channel rather than a person, so a customer created by
 * the projection needs somebody's book to land in. Guessing it — the signed-in
 * user, say — would quietly assign a thousand customers to whoever pressed the
 * button.
 */
export async function runBillImportAction(
  ownerEmail: string,
): Promise<Result<{ ran: string[] }>> {
  try {
    const ctx = await requireCapability("sheet.import");
    if (!ownerEmail.trim()) {
      return {
        ok: false,
        error: "Choose whose book new customers land in.",
        code: "validation",
        fieldErrors: [{ field: "owner", message: "Pick an owner first." }],
      };
    }

    const { runJob } = await import("@/lib/jobs");
    const results = await runJob("project-sheet", ctx.user.id, {
      owner: ownerEmail.trim(),
      bills: true,
    });

    refreshAccounts();
    const touched = results.reduce((a, r) => a + r.recordsAffected, 0);
    return {
      ok: true,
      data: { ran: results.map((r) => `${r.job}: ${r.detail}`) },
      message:
        touched > 0
          ? `Import finished — ${touched.toLocaleString("en-IN")} records touched`
          : "Import finished — nothing had changed since the last run",
    };
  } catch (e) {
    return fromThrown(e);
  }
}
