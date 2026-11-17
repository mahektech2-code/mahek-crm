"use server";

import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/access-control";
import { fromThrown, ok, type Result } from "@/lib/result";
import { approvableProducts, approveTo, declineTo, holdTo, releaseTo, sendBackTo, toReview, type ToReview } from "@/lib/services/to-approval-service";
import type { ApprovalLine } from "@/lib/erp/order-hub";

/* Thin over the service, which owns the `order.approve` check on every decision. */

function refresh() {
  try {
    revalidatePath("/accounts");
    revalidatePath("/apps");
    revalidatePath("/crm/my-orders");
    revalidatePath("/erp/order-hub");
    revalidatePath("/erp/mrp-check");
  } catch {
    /* no request context */
  }
}

async function run<T>(f: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    const r = await f();
    if (r.ok) refresh();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

/** One TO for the review dialog, with the products a line may be changed to. */
export async function loadToReviewAction(id: string): Promise<Result<{ review: ToReview; products: { id: string; name: string }[] }>> {
  try {
    await requireCapability("order.approve");
    const [review, products] = await Promise.all([toReview(id), approvableProducts()]);
    if (!review) return { ok: false, error: "That TO no longer exists.", code: "not_found" };
    return ok({ review, products });
  } catch (e) {
    return fromThrown(e);
  }
}

export async function approveToAction(id: string, lines: ApprovalLine[] | null) {
  return run(() => approveTo(id, lines));
}

export async function sendBackToAction(id: string, note: string) {
  return run(() => sendBackTo(id, note));
}

export async function holdToAction(id: string, reasonCode: string, note: string) {
  return run(() => holdTo(id, reasonCode, note));
}

export async function releaseToAction(id: string, note: string) {
  return run(() => releaseTo(id, note));
}

export async function declineToAction(id: string, reason: string) {
  return run(() => declineTo(id, reason));
}
