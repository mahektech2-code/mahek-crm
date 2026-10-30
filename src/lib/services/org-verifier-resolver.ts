import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { customers, leadStageTransitions, users } from "@/db/schema";
import { loadOrgData, orgVerifierFor } from "@/lib/services/lead-verifier";

/* ---------------------------------------------------------------------------
 * ORG CHART FIRST: WHO VERIFIES WHAT SOMEBODY REQUESTED.
 *
 * The person lower on the Org Chart makes the request and the nearest eligible
 * person above them verifies it. This is the ONE resolver for it, asked by the
 * routing of a Prospect request (`preparePromotion`), by the act of verifying
 * (`orgDesignatedGate`, which the console, the Sales Manager pipeline and the
 * handset all pass through) and by the Qualification review. Three callers, one
 * answer, so a screen can never offer a call the permission check then refuses.
 *
 * THE STARTING POINT is whoever MADE the request — never whoever owns the lead.
 * The walk, its skips (a leaver, no account, inactive, cannot verify) and its
 * refusals (a loop, two accounts on one employee) are `engines/org-verifier-chain`,
 * unchanged; it never guesses and the requester is never a candidate.
 *
 * WHEN THE CHART CANNOT ANSWER (the person is not linked in HRMS, or nobody above
 * them can verify) this says so and the CALLER falls back to the named-person
 * settings — as a fallback only, and made visible (`recordVerifierFallback`).
 * ------------------------------------------------------------------------- */

export type OrgChartVerifier =
  | { ok: true; id: string; name: string; depth: number }
  | { ok: false; reason: string; message: string };

export async function orgChartVerifierFor(requesterId: string): Promise<OrgChartVerifier> {
  const data = await loadOrgData();
  const r = await orgVerifierFor(data, requesterId, null, new Map(), "verify");
  if (r.ok) {
    return { ok: true, id: r.verifierUserId, name: data.nameOfUser.get(r.verifierUserId) ?? "", depth: r.depth };
  }
  return { ok: false, reason: r.code, message: r.message };
}

/**
 * WHAT IS PENDING ON A LEAD, for the act of verifying: whether somebody is waiting
 * on a verification, who ASKED for it, and who it was addressed to.
 *
 * Two ways in. A REQUEST the desk sent (`prospect_request_state` awaiting or
 * follow-up) names its requester. A direct CONVERSION has no request row: the lead
 * is a Prospect, not yet verified, and the person who converted it is the actor of
 * its latest move to Prospect. Either way `pending` is false once verified.
 */
export async function pendingRequestOf(
  customerId: string,
): Promise<{ requesterId: string | null; addresseeId: string | null; pending: boolean } | null> {
  const [row] = await db
    .select({
      requesterId: customers.prospectRequestedById,
      state: customers.prospectRequestState,
      addresseeId: customers.leadNextActionOwnerId,
      stage: customers.leadStage,
      verifiedAt: customers.leadVerifiedAt,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!row) return null;
  const awaiting = row.state === "awaiting" || row.state === "followup";
  if (awaiting) return { requesterId: row.requesterId, addresseeId: row.addresseeId, pending: true };
  if (row.stage === "prospect" && !row.verifiedAt) {
    const [t] = await db
      .select({ actorId: leadStageTransitions.actorId })
      .from(leadStageTransitions)
      .where(and(eq(leadStageTransitions.customerId, customerId), eq(leadStageTransitions.toStage, "prospect")))
      .orderBy(desc(leadStageTransitions.at))
      .limit(1);
    return { requesterId: t?.actorId ?? null, addresseeId: row.addresseeId, pending: true };
  }
  return { requesterId: null, addresseeId: row.addresseeId, pending: false };
}

export async function userRole(userId: string): Promise<string | null> {
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.role ?? null;
}

/** Why the chart could not answer, in words the lead's history can carry. The requester is "the person who asked". */
export function orgFallbackWords(reason: string): string {
  switch (reason) {
    case "subject_unmapped":
      return "the person who asked is not linked to an employee record in HRMS";
    case "subject_unknown":
      return "the person who asked has an employee link that is not in the employee master";
    case "no_manager":
      return "nobody is recorded above the person who asked on the Org Chart";
    case "chain_exhausted":
      return "nobody above the person who asked on the Org Chart can verify (left, no active account, or no permission)";
    case "cycle":
      return "the Org Chart loops back on itself above the person who asked";
    case "ambiguous_account":
      return "two accounts are linked to one manager on the person's reporting line";
    default:
      return "the Org Chart could not name a verifier";
  }
}
