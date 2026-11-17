import { ladderFor } from "@/lib/engines/lead-ladder";
import type { LeadSalesType } from "@/lib/lead-labels";

/* ---------------------------------------------------------------------------
 * THE ONE-REVIEW FLOW applies to a lead whose Sales Manager verifies it as a
 * Prospect — a lead standing at Prospect, or a Suspect the calling desk has asked
 * to promote — on a ladder that has BOTH a Qualification rung and a Sample / Trial
 * rung (direct and third-party). There the review draws every question once, the
 * Sales Manager answers the ones only Qualification asks, and a single Confirm
 * verifies the Prospect, completes Qualification and moves the lead to Sample /
 * Trial: there is no separate Telecaller Qualification step in between.
 *
 * A distributor has a different checklist, and a lead with no sales type sits
 * outside the funnel altogether: both keep today's flow. Pure, so the review, the
 * save and the confirm cannot disagree about who it applies to.
 * ------------------------------------------------------------------------- */

const SUSPECT_LIKE = ["suspect", "new", "contacted"];

export function combinedReviewApplies(i: {
  stage: string | null | undefined;
  salesType: string | null | undefined;
  /** The calling desk has asked for this Suspect to become a Prospect. */
  deskRequest?: boolean;
}): boolean {
  if (!i.salesType || i.salesType === "distributor") return false;
  const atProspect = i.stage === "prospect";
  const requested = Boolean(i.deskRequest) && !!i.stage && SUSPECT_LIKE.includes(i.stage);
  if (!atProspect && !requested) return false;
  const ladder = ladderFor(i.salesType as LeadSalesType);
  return ladder.includes("qualification") && ladder.includes("sample_trial");
}
