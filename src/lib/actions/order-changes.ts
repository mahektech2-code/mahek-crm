"use server";

import { revalidatePath } from "next/cache";
import { decideOrderChange } from "../services/order-change-service";
import { fromThrown, type Result } from "../result";

/** Accounts deciding a change a salesman asked for on an approved order. */
export async function decideOrderChangeAction(
  requestId: string,
  decision: "accept" | "decline",
  note: string | null,
): Promise<Result> {
  try {
    const r = await decideOrderChange(requestId, decision, note);
    try {
      revalidatePath("/accounts/order-changes");
      revalidatePath("/accounts");
    } catch {
      /* no request context */
    }
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}
