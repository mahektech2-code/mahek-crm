/* ---------------------------------------------------------------------------
 * THE PROSPECT REVIEW — what the designated verifier decides BEFORE
 * Qualification opens, and the words for it. Pure and client-safe.
 *
 * The unified review (Suspect + Prospect answers on one page) is now the PRIMARY
 * verification: a Prospect submitted for Qualification is sent to its designated
 * verifier, who confirms it (which opens Qualification) or returns it with a
 * reason. The verification CALL is optional — recorded after that decision, never
 * the thing Qualification waits for.
 * ------------------------------------------------------------------------- */

/** What the lead's next-action band says while a Prospect is with the verifier or has been returned. */
export const PROSPECT_REVIEW_NEXT = {
  review: "Review the Suspect and Prospect answers",
  returned: "Correct and resubmit — returned by the verifier",
} as const;

/** The audit actions the Prospect review files, so the history can read them back. */
export const PROSPECT_REVIEW_AUDIT = {
  confirm: "lead.prospectReview.confirm",
  returned: "lead.prospectReview.return",
  resubmit: "lead.prospectReview.resubmit",
  /** A desk's Prospect request sent back — the existing action, read here as a return. */
  requestReturned: "lead.prospectRequest.return",
} as const;

export type ProspectReviewState = "pending" | "returned" | "confirmed" | "none";

/**
 * Where a lead stands in the Prospect review. A lead is WAITING when it is a
 * Suspect with a desk's request outstanding, or a Prospect nobody has confirmed;
 * it is RETURNED when the verifier sent it back and nobody has resubmitted it.
 * Anything else has no Prospect review to make.
 */
export function prospectReviewStateOf(lead: {
  stage: string | null;
  verifiedAt: Date | string | null;
  nextAction: string | null;
  requestState: string | null;
}): ProspectReviewState {
  const suspectLike = !lead.stage || ["suspect", "new", "contacted"].includes(lead.stage);
  if (suspectLike) {
    if (lead.requestState === "awaiting" || lead.requestState === "followup") return "pending";
    if (lead.requestState === "returned") return "returned";
    return "none";
  }
  if (lead.stage !== "prospect") return "none";
  if (lead.verifiedAt) return "confirmed";
  if (lead.nextAction === PROSPECT_REVIEW_NEXT.returned) return "returned";
  return "pending";
}
