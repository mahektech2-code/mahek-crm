"use server";

import { requireUser } from "@/lib/auth";
import { fromThrown, ok, type Result } from "@/lib/result";
import { actingOnBehalfOf } from "@/lib/services/lead-manager-authority";

/**
 * WHO THE SIGNED-IN PERSON IS WORKING THIS LEAD ON BEHALF OF, or null.
 *
 * Read by the Reverse and Mark-as-Dead dialogs when they open, so the marker is
 * the same fact the server writes into the audit row — asked of the lead row and
 * the Org Chart, never of anything the browser says. It decides nothing: both
 * actions ask their own scope and capability questions again.
 */
export async function actingForLead(customerId: string): Promise<Result<{ ownerName: string } | null>> {
  try {
    const user = await requireUser();
    const acting = await actingOnBehalfOf(customerId, user.id);
    return ok(acting ? { ownerName: acting.ownerName } : null);
  } catch (e) {
    return fromThrown(e);
  }
}
