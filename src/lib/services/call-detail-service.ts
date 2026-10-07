import "server-only";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { callOpportunities, calls } from "@/db/schema";
import { describeCall, type CallDetailView } from "../call-detail";

/**
 * The readable detail of a batch of calls, keyed by call id.
 *
 * ONE QUERY FOR THE CALLS AND ONE FOR THEIR OPPORTUNITIES, however many are
 * asked for: the timeline page is ten rows and the call history four hundred,
 * and a read per row would make the second a four-hundred-query screen. Only
 * calls that actually have something to say are in the map — every call logged
 * before these columns existed is absent from it, and the screens draw those
 * exactly as they always did.
 *
 * Read-only, and it re-reads rather than being handed the rows, so a screen
 * that already selected the whole `calls` row for other reasons does not have
 * to be reshaped to feed it.
 */
export async function callDetailsFor(callIds: string[]): Promise<Map<string, CallDetailView>> {
  const out = new Map<string, CallDetailView>();
  if (!callIds.length) return out;

  const [rows, opps] = await Promise.all([
    db
      .select({
        id: calls.id,
        interactionType: calls.interactionType,
        outcome: calls.outcome,
        callReason: calls.callReason,
        callerRole: calls.callerRole,
        callerName: calls.callerName,
        reasonDetail: calls.reasonDetail,
        outcomeDetail: calls.outcomeDetail,
        nextActions: calls.nextActions,
        nextActionDate: calls.nextActionDate,
        opportunityAnswer: calls.opportunityAnswer,
        contextSnapshot: calls.contextSnapshot,
      })
      .from(calls)
      .where(inArray(calls.id, callIds)),
    db
      .select({
        callId: callOpportunities.callId,
        product: callOpportunities.product,
        estimatedQuantity: callOpportunities.estimatedQuantity,
        estimatedValuePaise: callOpportunities.estimatedValuePaise,
        expectedOrderDate: callOpportunities.expectedOrderDate,
        status: callOpportunities.status,
      })
      .from(callOpportunities)
      .where(inArray(callOpportunities.callId, callIds)),
  ]);

  const oppByCall = new Map(opps.map((o) => [o.callId, o]));
  for (const r of rows) {
    const view = describeCall({
      interactionType: r.interactionType,
      outcome: r.outcome,
      callReason: r.callReason,
      callerRole: r.callerRole,
      callerName: r.callerName,
      reasonDetail: r.reasonDetail,
      outcomeDetail: r.outcomeDetail,
      nextActions: r.nextActions,
      nextActionDate: r.nextActionDate,
      opportunityAnswer: r.opportunityAnswer,
      opportunity: oppByCall.get(r.id) ?? null,
      contextSnapshot: r.contextSnapshot,
    });
    if (view) out.set(r.id, view);
  }
  return out;
}
