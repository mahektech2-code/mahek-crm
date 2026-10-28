"use server";

import { revalidatePath } from "next/cache";
import { canOpenModule } from "@/lib/access";
import { resolveScope } from "@/lib/access-control";
import { err, fromThrown, type Result } from "@/lib/result";
import type { Candidate } from "@/lib/engines/bank-statements";
import * as S from "@/lib/services/bank-statement-service";
import { confirmImpact } from "@/lib/impact/registry";
import { impactPair } from "@/lib/impact/kinds/crm-keys";
import { accountsDeskRefusal, BANK_HOME, BANK_RECONCILE } from "@/lib/impact/kinds/accounts";
import type { ImpactConfirmation } from "@/lib/impact/types";

/* ---------------------------------------------------------------------------
 * Bank statement management's writes. Each asks for the SCREEN first — a
 * server action is a URL and a hidden button is not a permission — and the
 * service then asks for the capability (`payment.record` or
 * `payment.confirm`).
 * ------------------------------------------------------------------------- */

async function opens(...keys: string[]): Promise<boolean> {
  const ctx = await resolveScope();
  for (const k of keys) if (await canOpenModule(ctx.user.id, k)) return true;
  return false;
}

async function run<T>(keys: string[], fn: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    if (!(await opens(...keys))) return err("Bank statement management is not on your account.", "not_permitted");
    const r = await fn();
    revalidatePath("/accounts/bank-statements");
    revalidatePath("/accounts/bank-reconcile");
    revalidatePath("/accounts/bank-uploads");
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

const HOME = [S.BANK_MODULES.home, S.BANK_MODULES.reconcile, S.BANK_MODULES.uploads];
const REC = [S.BANK_MODULES.reconcile];

export async function bankUploadStatus(uploadId: string): Promise<S.UploadDetail | null> {
  if (!(await opens(...HOME))) return null;
  return S.uploadStatus(String(uploadId));
}

export async function bankEditUploadRows(uploadId: string, edits: S.RowEdit[]) {
  return run(HOME, () => S.editUploadRows(String(uploadId), Array.isArray(edits) ? edits.slice(0, 500) : []));
}

export async function bankImportUpload(uploadId: string) {
  return run(HOME, () => S.importUpload(String(uploadId)));
}

/* The three below are confirmed against what the person was shown: the PDF
   and its unread lines going, the records a match leaves standing, the bills a
   returned cheque makes owed again. Here, in the action, so the service's own
   callers and tests keep working — and after the desk's own question, asked
   in the service's words, so a refusal reads as it always did. */
async function confirmedAt(
  modules: readonly string[],
  capability: "payment.confirm" | "payment.record",
  kind: string,
  id: string,
  confirmation: ImpactConfirmation | undefined,
): Promise<Result<never> | null> {
  const closed = await accountsDeskRefusal("bank", modules, capability);
  if (closed) return err(closed, "not_permitted");
  return confirmImpact(kind, id, confirmation);
}

export async function bankDiscardUpload(uploadId: string, confirmation?: ImpactConfirmation) {
  return run(HOME, async () => {
    const refusal = await confirmedAt(BANK_HOME, "payment.record", "accounts-bank-upload-discard", String(uploadId), confirmation);
    return refusal ?? S.discardUpload(String(uploadId));
  });
}

export async function bankLineDetail(lineId: string): Promise<S.LineDetail | null> {
  if (!(await opens(...REC))) return null;
  return S.lineDetail(String(lineId));
}

export async function bankAccept(lineId: string, c: Pick<Candidate, "kind" | "id">, via: "suggestion" | "hand" = "hand") {
  return run(REC, () => S.acceptCandidate(String(lineId), { kind: c.kind, id: c.id ?? null }, via === "suggestion" ? "suggestion" : "hand"));
}

export async function bankAcceptAll(lineIds: string[]) {
  return run(REC, () => S.acceptAll(Array.isArray(lineIds) ? lineIds.map(String) : []));
}

export async function bankDismiss(lineId: string, c: Pick<Candidate, "kind" | "id">) {
  return run(REC, () => S.dismissCandidate(String(lineId), { kind: c.kind, id: c.id ?? null }));
}

export async function bankMarkKit(lineId: string): Promise<S.MarkKit | null> {
  if (!(await opens(...REC))) return null;
  return S.markKit(String(lineId));
}

export async function bankCustomerBills(customerId: string) {
  if (!(await opens(...REC))) return [];
  return S.customerBills(String(customerId));
}

export async function bankMark(lineId: string, x: S.MarkInput) {
  return run(REC, () => S.markLine(String(lineId), x));
}

export async function bankIgnore(lineId: string, reason: string) {
  return run(REC, () => S.ignoreLine(String(lineId), String(reason ?? "")));
}

export async function bankRestore(lineId: string) {
  return run(REC, () => S.restoreLine(String(lineId)));
}

export async function bankUndo(lineId: string, confirmation?: ImpactConfirmation) {
  return run(REC, async () => {
    const refusal = await confirmedAt(BANK_RECONCILE, "payment.confirm", "accounts-bank-unmatch", String(lineId), confirmation);
    return refusal ?? S.undoMatch(String(lineId));
  });
}

export async function bankEditLine(lineId: string, x: { date: string; description: string; reference: string | null; debitPaise: number; creditPaise: number; balancePaise: number | null }) {
  return run(REC, () =>
    S.editLine(String(lineId), {
      date: String(x.date ?? ""),
      description: String(x.description ?? ""),
      reference: x.reference ? String(x.reference) : null,
      debitPaise: Math.max(0, Math.round(Number(x.debitPaise) || 0)),
      creditPaise: Math.max(0, Math.round(Number(x.creditPaise) || 0)),
      balancePaise: x.balancePaise == null || !Number.isFinite(Number(x.balancePaise)) ? null : Math.round(Number(x.balancePaise)),
    }),
  );
}

export async function bankReverseForReturn(lineId: string, receiptId: string, confirmation?: ImpactConfirmation) {
  return run(REC, async () => {
    const refusal = await confirmedAt(BANK_RECONCILE, "payment.confirm", "accounts-bank-return", impactPair(String(lineId), String(receiptId)), confirmation);
    return refusal ?? S.reverseForReturn(String(lineId), String(receiptId));
  });
}

export async function bankConfirmAmount(lineId: string, receiptId: string) {
  return run(REC, () => S.confirmBankAmount(String(lineId), String(receiptId)));
}

export async function bankSaveAccount(x: { id?: string | null; name: string; bankName: string | null; last4: string | null; accountType: string | null; active: boolean }) {
  return run(HOME, () =>
    S.saveBankAccount({
      id: x.id ? String(x.id) : null,
      name: String(x.name ?? ""),
      bankName: x.bankName ? String(x.bankName) : null,
      last4: x.last4 ? String(x.last4) : null,
      accountType: x.accountType ? String(x.accountType) : null,
      active: x.active !== false,
    }),
  );
}
