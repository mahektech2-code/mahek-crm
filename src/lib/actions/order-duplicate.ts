"use server";

import { getCurrentUser } from "@/lib/auth";
import { fromThrown, okVoid, type Result } from "@/lib/result";
import { tellSameOrder } from "@/lib/erp/order-hub";

/**
 * "SAME ORDER - DON'T CREATE" on the ERP's New order form: nothing is saved,
 * and whoever punched the first one is told somebody tried to punch it again.
 */
export async function reportSameOrderAction(matchId: string): Promise<Result> {
  try {
    const user = await getCurrentUser();
    if (!user) return { ok: false, error: "Sign in again.", code: "not_permitted" };
    await tellSameOrder(matchId, user.id);
    return okVoid("Not created - it is the same order");
  } catch (e) {
    return fromThrown(e);
  }
}
