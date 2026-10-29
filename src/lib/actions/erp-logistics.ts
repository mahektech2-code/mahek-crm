"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { err, fromThrown, type Result } from "@/lib/result";
import { ErpNotPermitted, erpContext, previewRefusal, requireErpWrite, type ErpContext } from "@/lib/erp/access";
import * as L from "@/lib/erp/logistics";
import * as T from "@/lib/erp/trips";
import type { ImpactConfirmation } from "@/lib/impact/types";

/* ---------------------------------------------------------------------------
 * The Logistics desk's writes. Every one re-checks the Logistics screen
 * (`transport`) — a server action is a URL — except the LR upload, which the
 * dispatch team may do from the Dispatch desk too, because collecting the LRs
 * is their job and attaching them is logistics'.
 * ------------------------------------------------------------------------- */

function refused(e: unknown): Result<never> {
  if (e instanceof ErpNotPermitted) return err(e.message, "not_permitted");
  return fromThrown(e);
}

function touched() {
  revalidatePath("/erp/transport", "layout");
  revalidatePath("/erp");
}

async function run<T>(fn: (ctx: ErpContext) => Promise<Result<T>>): Promise<Result<T>> {
  try {
    const ctx = await requireErpWrite("transport");
    const res = await fn(ctx);
    touched();
    return res;
  } catch (e) {
    return refused(e);
  }
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 500) : []);

export async function erpLogisticsDue(transportIds: string[], due: string) {
  return run((ctx) => L.setTransportDue(ctx, ids(transportIds), due));
}

export async function erpLogisticsAtTransport(transportIds: string[], packages?: Record<string, number | null>) {
  return run((ctx) => L.markAtTransport(ctx, ids(transportIds), packages));
}

export async function erpLogisticsPackages(transportId: string, packages: number | null) {
  return run((ctx) => L.setPackages(ctx, transportId, packages));
}

/** The dispatch team's upload: the Logistics screen or the Dispatch desk opens it. */
export async function erpLogisticsUploadLrs(items: L.LrInput[]) {
  try {
    const ctx = await erpContext();
    if (ctx.viewingAs) return err(previewRefusal(ctx.viewingAs), "not_permitted");
    const screen = ctx.screens.has("transport") ? "transport" : "dispatch";
    const checked = await requireErpWrite(screen);
    const res = await L.uploadLrs(checked, Array.isArray(items) ? items : []);
    /* The photos are read after the answer, so ten of them never hold the upload up. */
    if (res.ok && res.data.ids.length) {
      const newIds = res.data.ids;
      const job = async () => {
        const { readStoredLrs } = await import("@/lib/erp/lr-upload-read");
        await readStoredLrs(checked, newIds).catch((e) => console.error("[logistics] reading uploads failed:", e instanceof Error ? e.message : e));
      };
      try {
        after(job);
      } catch {
        await job();
      }
    }
    touched();
    revalidatePath("/erp/dispatch");
    return res;
  } catch (e) {
    return refused(e);
  }
}

/**
 * Reads an LR photo or PDF the person just uploaded into the row's fields —
 * a suggestion, nothing saved. Open to whoever may upload LRs.
 */
export async function erpLogisticsReadLr(fileId: string) {
  try {
    const ctx = await erpContext();
    if (ctx.viewingAs) return err(previewRefusal(ctx.viewingAs), "not_permitted");
    const screen = ctx.screens.has("transport") ? "transport" : "dispatch";
    const checked = await requireErpWrite(screen);
    if (typeof fileId !== "string" || !fileId) return err("No file to read.", "validation");
    const { readUploadedLr } = await import("@/lib/erp/lr-upload-read");
    return await readUploadedLr(checked, fileId);
  } catch (e) {
    return refused(e);
  }
}

export async function erpLogisticsEditLr(lrId: string, input: L.LrInput) {
  return run((ctx) => L.editLr(ctx, lrId, input));
}

export async function erpLogisticsVoidLr(lrId: string, reason: string, confirmation?: ImpactConfirmation) {
  return run((ctx) => L.voidLr(ctx, lrId, reason, confirmation));
}

export async function erpLogisticsAttach(lrId: string, transportIds: string[], opts: { expectedOn?: string | null; notify?: boolean; nextCallOn?: string | null }) {
  return run((ctx) => L.attachLr(ctx, lrId, ids(transportIds), opts ?? {}));
}

export async function erpLogisticsDetach(transportId: string, reason: string) {
  return run((ctx) => L.detachLr(ctx, transportId, reason));
}

export async function erpLogisticsUpdate(transportIds: string[], input: L.ConsignmentUpdate) {
  return run((ctx) => L.updateConsignment(ctx, ids(transportIds), input ?? {}));
}

export async function erpLogisticsIssue(transportIds: string[], input: { issue: string; note?: string | null; expectedOn?: string | null; notify?: boolean; customerReason?: string | null }) {
  return run((ctx) => L.raiseIssue(ctx, ids(transportIds), input));
}

export async function erpLogisticsClearIssue(transportIds: string[], note: string) {
  return run((ctx) => L.clearIssue(ctx, ids(transportIds), note ?? ""));
}

export async function erpLogisticsDelivered(transportIds: string[], input: { date: string; receivedBy?: string | null; proof?: string | null; note?: string | null; notify?: boolean; signedCopyId?: string | null }) {
  return run((ctx) => L.markDelivered(ctx, ids(transportIds), input));
}

/* ---- delivery proof on the Documents desk (0297) ---- */

export async function erpLogisticsSetKind(lrId: string, kind: "lr" | "signed_copy") {
  return run((ctx) => L.setLrKind(ctx, String(lrId ?? ""), kind));
}

export async function erpLogisticsReplaceFile(lrId: string, fileId: string) {
  return run((ctx) => L.replaceLrFile(ctx, String(lrId ?? ""), String(fileId ?? "")));
}

export async function erpLogisticsClearDuplicate(lrId: string) {
  return run((ctx) => L.clearDuplicate(ctx, String(lrId ?? "")));
}

export async function erpLogisticsDiscardDuplicate(lrId: string) {
  return run((ctx) => L.discardDuplicate(ctx, String(lrId ?? "")));
}

export async function erpLogisticsAttachReady(pairs: { lrId: string; transportIds: string[]; kind?: "lr" | "signed_copy"; date?: string | null; receivedBy?: string | null }[], opts: { notify?: boolean } = {}) {
  const clean = (Array.isArray(pairs) ? pairs : []).map((p) => ({ lrId: String(p?.lrId ?? ""), transportIds: ids(p?.transportIds), kind: p?.kind === "signed_copy" ? ("signed_copy" as const) : ("lr" as const), date: typeof p?.date === "string" ? p.date : null, receivedBy: typeof p?.receivedBy === "string" ? p.receivedBy : null })).filter((p) => p.lrId && p.transportIds.length);
  return run((ctx) => L.attachReady(ctx, clean, { notify: opts?.notify }));
}

export async function erpLogisticsDeliveredBy(transportIds: string[], transporter: string) {
  return run((ctx) => L.setDeliveredBy(ctx, ids(transportIds), String(transporter ?? "")));
}

export async function erpLogisticsReopen(transportId: string, reason: string, confirmation?: ImpactConfirmation) {
  return run((ctx) => L.reopen(ctx, transportId, reason ?? "", confirmation));
}

export async function erpLogisticsTransporter(input: Parameters<typeof L.saveTransporter>[1]) {
  return run((ctx) => L.saveTransporter(ctx, input));
}

export async function erpLogisticsMessageSent(messageId: string) {
  return run((ctx) => L.markMessageSent(ctx, messageId));
}

export async function erpLogisticsMessageSkip(messageId: string) {
  return run((ctx) => L.skipMessage(ctx, messageId));
}

export async function erpLogisticsMessageRetry(messageId: string) {
  return run((ctx) => L.retryMessage(ctx, messageId));
}

/* ---- trips and the transport payment (Order-to-Delivery PRD steps 10–11) ---- */

export async function erpTripSave(input: T.TripInput) {
  return run((ctx) => T.saveTrip(ctx, { ...input, transportIds: ids(input?.transportIds) }));
}

export async function erpTripAddBills(tripId: string, transportIds: string[]) {
  return run((ctx) => T.addToTrip(ctx, String(tripId ?? ""), ids(transportIds)));
}

export async function erpTripRemoveBill(transportId: string, confirmation?: ImpactConfirmation) {
  return run((ctx) => T.removeFromTrip(ctx, String(transportId ?? ""), confirmation));
}

/** Logistics records the confirmed payment; it does not make it. */
export async function erpTransportPaymentRecord(input: T.PaymentInput) {
  return run((ctx) => T.recordTransportPayment(ctx, { ...input, transportIds: ids(input?.transportIds) }));
}

export async function erpTransportPaymentReverse(paymentId: string, reason: string, confirmation?: ImpactConfirmation) {
  return run((ctx) => T.reverseTransportPayment(ctx, String(paymentId ?? ""), reason ?? "", confirmation));
}

export async function erpLogisticsMergeTransporter(fromId: string, intoId: string, confirmation?: ImpactConfirmation) {
  return run((ctx) => L.mergeTransporter(ctx, String(fromId ?? ""), String(intoId ?? ""), confirmation));
}
