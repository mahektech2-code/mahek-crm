"use server";

import { revalidatePath } from "next/cache";
import { err, type Result } from "@/lib/result";
import { HireNotPermitted, requireHireCap } from "../access";
import type { HireCap } from "../roles";
import { decideApproval, issueOffer, recordResponse, saveOffer, updateTracking, withdrawOffer, type OfferInput, type ResponseInput } from "../services/offers";
import { confirmImpact } from "@/lib/impact/registry";
import type { ImpactConfirmation } from "@/lib/impact/types";
import { confirmFields, setDocumentStatus, setItem, unmask, uploadDocument, type ItemKey } from "../services/onboarding";
import { provision, type Provisioned } from "../services/provision";
import {
  addBgvRemark,
  addShipment,
  approveEmploymentDoc,
  courierEvent,
  issueAsset,
  prepareEmploymentDocs,
  publishPlan,
  requestDocuments,
  returnAsset,
  revealBgvRemarks,
  saveBgv,
  savePlanDraft,
  saveTemplate,
  sendEmploymentDocs,
  setAssetApplicable,
  type BgvInput,
  type PlanInput,
  type ShipmentInput,
} from "../services/onboarding-records";

/* Onboarding's writes. Each checks its own capability — a server action is a URL. */

async function guarded<T>(cap: HireCap, fn: (ctx: Awaited<ReturnType<typeof requireHireCap>>) => Promise<Result<T>>): Promise<Result<T>> {
  try {
    const ctx = await requireHireCap(cap);
    const r = await fn(ctx);
    if (r.ok) revalidatePath("/hire", "layout");
    return r;
  } catch (e) {
    if (e instanceof HireNotPermitted) return err(e.message, "not_permitted");
    console.error("hire onboarding:", e instanceof Error ? e.message : e);
    return err("That could not be saved. Try again.");
  }
}

export async function saveOfferAction(applicationId: string, input: OfferInput) {
  return guarded("offer", (ctx) => saveOffer(ctx, applicationId, input));
}

export async function issueOfferAction(applicationId: string) {
  return guarded("offer", (ctx) => issueOffer(ctx, applicationId));
}

export async function offerResponseAction(applicationId: string, input: ResponseInput) {
  return guarded("offer", (ctx) => recordResponse(ctx, applicationId, input));
}

/** Rescind an issued or accepted offer — after the impact modal, with a reason kept on the record. */
export async function withdrawOfferAction(applicationId: string, reason: string, confirmation?: ImpactConfirmation) {
  return guarded("offer", async (ctx) => {
    const refusal = await confirmImpact("hire-offer-withdraw", applicationId, confirmation);
    if (refusal) return refusal;
    return withdrawOffer(ctx, applicationId, reason);
  });
}

export async function offerTrackingAction(applicationId: string, patch: { courierStatus?: string; backgroundCheck?: string }) {
  return guarded("offer", (ctx) => updateTracking(ctx, applicationId, patch));
}

export async function uploadDocumentAction(form: FormData) {
  const applicationId = String(form.get("applicationId") ?? "");
  const requirementKey = String(form.get("requirementKey") ?? "");
  const file = form.get("file");
  if (!(file instanceof File)) return err("Choose a file.", "validation");
  return guarded("documents", (ctx) => uploadDocument(ctx, applicationId, requirementKey, file));
}

export async function confirmFieldsAction(documentId: string, input: { fields: { label: string; value: string }[]; idNumber?: string; verify: boolean }) {
  return guarded("documents", (ctx) => confirmFields(ctx, documentId, input));
}

export async function documentStatusAction(applicationId: string, requirementKey: string, status: "failed" | "waived" | "manual_review", notes: string) {
  return guarded("documents", (ctx) => setDocumentStatus(ctx, applicationId, requirementKey, status, notes));
}

/** Unmasking is its own capability and its own audit line; no revalidation, the value never re-renders server-side. */
export async function unmaskAction(vaultId: string): Promise<Result<{ value: string }>> {
  try {
    const ctx = await requireHireCap("unmask");
    return await unmask(ctx, vaultId);
  } catch (e) {
    if (e instanceof HireNotPermitted) return err(e.message, "not_permitted");
    return err("The number could not be shown.");
  }
}

export async function setItemAction(applicationId: string, k: ItemKey, done: boolean, serial?: string | null) {
  return guarded("onboard", (ctx) => setItem(ctx, applicationId, k, done, serial));
}

export async function provisionAction(applicationId: string, note: string): Promise<Result<Provisioned>> {
  return guarded("provision", (ctx) => provision(ctx, applicationId, note));
}

/* ------------------------------------------------ Onboarding & Training PRD */



export async function decideApprovalAction(applicationId: string, decision: "approved" | "refused", note: string) {
  return guarded("compensationApprove", (ctx) => decideApproval(ctx, applicationId, decision, note));
}

export async function requestDocumentsAction(applicationId: string, keys: string[]) {
  return guarded("documents", (ctx) => requestDocuments(ctx, applicationId, keys));
}

export async function saveBgvAction(applicationId: string, input: BgvInput) {
  return guarded("bgCheck", (ctx) => saveBgv(ctx, applicationId, input));
}

export async function addBgvRemarkAction(applicationId: string, text: string) {
  return guarded("bgCheck", (ctx) => addBgvRemark(ctx, applicationId, text));
}

/** Reading the remarks is its own capability and a PII audit line; nothing re-renders. */
export async function revealBgvRemarksAction(applicationId: string): Promise<Result<{ remarks: string[] }>> {
  try {
    const ctx = await requireHireCap("bgRemarks");
    return await revealBgvRemarks(ctx, applicationId);
  } catch (e) {
    if (e instanceof HireNotPermitted) return err(e.message, "not_permitted");
    return err("The remarks could not be shown.");
  }
}

export async function prepareEmploymentDocsAction(applicationId: string, onlyKeys?: string[]) {
  return guarded("employmentDocs", (ctx) => prepareEmploymentDocs(ctx, applicationId, onlyKeys));
}

export async function approveEmploymentDocAction(docId: string) {
  return guarded("employmentDocs", (ctx) => approveEmploymentDoc(ctx, docId));
}

export async function sendEmploymentDocsAction(applicationId: string, docIds: string[]) {
  return guarded("employmentDocs", (ctx) => sendEmploymentDocs(ctx, applicationId, docIds));
}



export async function addShipmentAction(applicationId: string, input: ShipmentInput) {
  return guarded("courier", (ctx) => addShipment(ctx, applicationId, input));
}

export async function courierEventAction(shipmentId: string, input: { status: string; on: string; remarks?: string | null; company?: string | null; trackingNo?: string | null }) {
  return guarded("courier", (ctx) => courierEvent(ctx, shipmentId, input));
}

export async function issueAssetAction(applicationId: string, key: string, input: { serial?: string | null; issuedOn: string }) {
  return guarded("assets", (ctx) => issueAsset(ctx, applicationId, key, input));
}

export async function setAssetApplicableAction(applicationId: string, key: string, applicable: boolean, reason: string) {
  return guarded("assets", (ctx) => setAssetApplicable(ctx, applicationId, key, applicable, reason));
}


export async function returnAssetAction(applicationId: string, key: string, returnedOn: string) {
  return guarded("assets", (ctx) => returnAsset(ctx, applicationId, key, returnedOn));
}

export async function savePlanAction(key: string, input: PlanInput, publish: boolean) {
  return guarded("incentivePlans", async (ctx) => {
    const saved = await savePlanDraft(ctx, key, input);
    if (!saved.ok || !publish) return saved;
    const pub = await publishPlan(ctx, key.trim().toLowerCase());
    return pub.ok ? { ...saved, message: pub.message } : pub;
  });
}

export async function saveTemplateAction(key: string, input: { title: string; body: string }, publish: boolean) {
  return guarded("employmentDocs", (ctx) => saveTemplate(ctx, key, input, publish));
}
