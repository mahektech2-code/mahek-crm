"use server";

import { revalidatePath } from "next/cache";
import { err, type Result } from "@/lib/result";
import { HireNotPermitted, requireHireCap } from "../access";
import type { HireCap } from "../roles";
import { issueOffer, recordResponse, saveOffer, updateTracking, type OfferInput, type ResponseInput } from "../services/offers";
import { confirmFields, setDocumentStatus, setItem, unmask, uploadDocument, type ItemKey } from "../services/onboarding";
import { provision, type Provisioned } from "../services/provision";

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
