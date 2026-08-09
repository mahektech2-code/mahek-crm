"use server";

import { revalidatePath } from "next/cache";
import {
  approveOrder,
  declineOrder,
} from "@/lib/services/order-approval-service";
import { fromThrown, type Result } from "@/lib/result";

/**
 * Thin over the service, which owns the capability check. Approving is
 * verified there and not merely hidden here — a disabled button is a
 * courtesy, not a permission.
 */
function refresh() {
  try {
    revalidatePath("/accounts");
    revalidatePath("/apps");
    revalidatePath("/crm/dashboard");
    revalidatePath("/crm/eod");
  } catch {
    /* no request context — nothing cached to invalidate */
  }
}

export async function approveOrderAction(orderId: string): Promise<Result> {
  try {
    const r = await approveOrder(orderId);
    refresh();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function declineOrderAction(
  orderId: string,
  reason: string,
): Promise<Result> {
  try {
    const r = await declineOrder(orderId, reason);
    refresh();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}
