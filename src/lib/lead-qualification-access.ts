/* ---------------------------------------------------------------------------
 * WHEN QUALIFICATION CAN BE WRITTEN.
 *
 * Qualification belongs to the Telecaller AFTER the Sales Manager has verified
 * the Prospect. Before that it is not "started early" — it does not exist yet,
 * and an answer typed against a lead nobody has verified is an answer whose
 * whole basis is still being checked. So the answers are writable at
 * Qualification (and at the legacy `qualified` rung, which is the same job on
 * the six-rung ladder) and at no other stage.
 *
 * PURE AND CLIENT-SAFE, because two things must say the same sentence: the
 * server actions that refuse the write, and the screen that draws its boxes
 * disabled with the reason underneath. A refusal the screen could not explain
 * is one the Telecaller meets by pressing Save and losing what they typed.
 *
 * The four answers this covers — GSTIN, application, credit days, buyer — are
 * the ones the Calling Desk ALSO collects before a lead is a Prospect, through
 * its own writes. Those are the desk's and are not touched by this rule.
 * ------------------------------------------------------------------------- */

/** The rungs at which Qualification is the live job. */
const OPEN_RUNGS: readonly string[] = ["qualification", "qualified"];

/** The Qualification-only answers `saveProspectFields` takes from the qualify screen. */
export const QUALIFICATION_ONLY_FIELDS = ["gstin", "application", "creditDaysWanted", "buyer"] as const;

export type QualificationAccess =
  | { writable: true; reason: null }
  | { writable: false; reason: string };

export function qualificationAccess(stage: string | null | undefined): QualificationAccess {
  if (stage && OPEN_RUNGS.includes(stage)) return { writable: true, reason: null };
  if (stage === "prospect" || stage === "contacted") {
    return {
      writable: false,
      reason:
        "Waiting for the Sales Manager to verify this Prospect. Qualification opens as soon as they do.",
    };
  }
  if (!stage || stage === "suspect" || stage === "new") {
    return {
      writable: false,
      reason:
        "This lead is not a Prospect yet. Qualification opens after the Sales Manager has verified it.",
    };
  }
  return {
    writable: false,
    reason: "This lead is past Qualification, so its answers are no longer edited here.",
  };
}
