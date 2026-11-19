"use server";

import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/access-control";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { z } from "zod";
import { approvableProducts, approveTo, declineTo, holdTo, releaseTo, saveToLines, sendBackTo, toReview, type ToReview } from "@/lib/services/to-approval-service";
import type { ApprovalLine } from "@/lib/erp/order-hub";
import { confirmImpact } from "@/lib/impact/registry";
import type { ImpactConfirmation } from "@/lib/impact/types";

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

/**
 * Send back and decline: the reason first, then the impact modal. The
 * confirmation is asked after the capability and once there is a reason, so
 * an empty one keeps the service's words.
 */
async function confirmed(kind: string, id: string, text: string, confirmation: ImpactConfirmation | null | undefined) {
  await requireCapability("order.approve");
  return text.trim() ? confirmImpact(kind, id, confirmation) : null;
}

export async function sendBackToAction(id: string, note: string, confirmation?: ImpactConfirmation | null) {
  return run(async (): Promise<Result<unknown>> => (await confirmed("accounts-to-send-back", id, note, confirmation)) ?? sendBackTo(id, note));
}

export async function holdToAction(id: string, reasonCode: string, note: string) {
  return run(() => holdTo(id, reasonCode, note));
}

export async function releaseToAction(id: string, note: string) {
  return run(() => releaseTo(id, note));
}

export async function declineToAction(id: string, reason: string, confirmation?: ImpactConfirmation | null) {
  return run(async (): Promise<Result<unknown>> => (await confirmed("accounts-to-decline", id, reason, confirmation)) ?? declineTo(id, reason));
}

/* Lines only: `strict` refuses a line or a body that carries anything else (a party, a godown). */
const toLines = z.array(z.object({ skuId: z.string(), qtyCans: z.number(), ratePaise: z.number().int().nullable(), discountBp: z.number().int().nullable() }).strict()).max(500);

/** Accounts save a TO's lines without deciding it; it stays waiting for them. */
export async function saveToLinesAction(id: string, lines: ApprovalLine[]) {
  const parsed = toLines.safeParse(lines);
  if (!parsed.success) return err("Accounts change the lines only. Open the TO again.", "validation");
  return run(() => saveToLines(id, parsed.data));
}
