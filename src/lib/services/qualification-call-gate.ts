import "server-only";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customers, leadStageTransitions, leadVerificationCorrections, mbosLeadValidations } from "@/db/schema";
import { PROSPECT_REVIEW_AUDIT } from "@/lib/prospect-review";
import { qualificationAccess } from "@/lib/lead-qualification-access";
import { REVIEW_SAVED_ACTION } from "@/lib/qualification-review";

/* ---------------------------------------------------------------------------
 * THE VERIFICATION CALL COMES AFTER THE REVIEW HAS BEEN SAVED — and it is never
 * required.
 *
 * While a lead is in Qualification, the designated Sales Manager first reads and
 * corrects the consolidated answers and saves the review. Only then may a
 * verification call be recorded against it. The call stays completely optional:
 * nothing here is read by the verdict, by the gate into Sample / Trial or by any
 * stage move. This is one question — "may a call be recorded on this lead right
 * now?" — asked by the action that records one, and by every screen that offers
 * the button, so a hidden button and a refused action cannot disagree.
 *
 * "SAVED" IS A MARK IN THE AUDIT LOG, not a column: the review save writes one
 * `lead.qualificationReview.saved` row (see `saveQualificationReviewEdits`),
 * and the mark counts for the stay in Qualification it was made in — a save
 * from before the lead last entered Qualification does not open the call for the
 * next one. Nothing is added to the schema, and the history of every earlier
 * review and call is untouched.
 *
 * ONLY WHERE THERE IS A REVIEW TO SAVE. A lead before Qualification opens is
 * verified by the Prospect review or by the call itself (the alternative door,
 * unchanged), and a lead already past Qualification has had its review decided.
 * A distributor's checklist is not edited from the review at all, so it has no
 * save to wait for and is left alone.
 * ------------------------------------------------------------------------- */

export const CALL_AFTER_REVIEW =
  "The verification call opens once the Qualification review has been saved. Save the review first — it can be saved with no changes — and then the call is there if you want it. It is optional.";

/** The pure rule, so it is testable without a database. */
export function callAllowed(input: {
  stage: string | null | undefined;
  salesType: string | null | undefined;
  enteredQualificationAt: Date | null;
  savedAt: readonly Date[];
}): boolean {
  if (!qualificationAccess(input.stage).writable) return true;
  if (input.salesType === "distributor") return true;
  const since = input.enteredQualificationAt?.getTime() ?? 0;
  return input.savedAt.some((d) => d.getTime() >= since);
}

/* ---------------------------------------------------------------------------
 * STEP 1 OF THE SALES MANAGER'S VERIFICATION: THE CALL COMES FIRST.
 *
 * The manager rings the customer, and only then checks the recorded answers
 * against what was said: all right, she confirms; any wrong, she rejects and the
 * owner corrects. So Confirm needs a call made for THIS review — one recorded
 * since the lead last went to the manager (it became a Prospect, the desk asked
 * for it, or the owner resubmitted it after a rejection). A rejection starts a
 * new round and so needs a new call: the answers it was about have changed.
 *
 * Only a call that reached the shop counts (`verified`); a follow-up or a failed
 * verification is not a call that checked anything. And a call that found an
 * answer wrong (`corrected`) is not one she can confirm on.
 * ------------------------------------------------------------------------- */

export type ReviewCallStatus = {
  /** A call that reached the shop has been recorded for this round of the review. */
  made: boolean;
  /** How many of the answers the call found different from what the customer said. */
  corrections: number;
  at: Date | null;
};

export async function reviewCallStatus(customerId: string): Promise<ReviewCallStatus> {
  const [lead] = await db
    .select({ requestedAt: customers.prospectRequestedAt })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  const [entered] = await db
    .select({ at: leadStageTransitions.at })
    .from(leadStageTransitions)
    .where(and(eq(leadStageTransitions.customerId, customerId), eq(leadStageTransitions.toStage, "prospect")))
    .orderBy(desc(leadStageTransitions.at))
    .limit(1);
  const [resubmitted] = await db
    .select({ at: auditLog.at })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "customer"),
        eq(auditLog.entityId, customerId),
        inArray(auditLog.action, [PROSPECT_REVIEW_AUDIT.resubmit, PROSPECT_REVIEW_AUDIT.returned]),
      ),
    )
    .orderBy(desc(auditLog.at))
    .limit(1);
  const since = [lead?.requestedAt, entered?.at, resubmitted?.at]
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const [call] = await db
    .select({ id: mbosLeadValidations.id, at: mbosLeadValidations.calledAt })
    .from(mbosLeadValidations)
    .where(
      and(
        eq(mbosLeadValidations.customerId, customerId),
        eq(mbosLeadValidations.verdict, "confirmed"),
        ...(since ? [gte(mbosLeadValidations.calledAt, since)] : []),
      ),
    )
    .orderBy(desc(mbosLeadValidations.calledAt))
    .limit(1);
  if (!call) return { made: false, corrections: 0, at: null };

  const corrected = await db
    .select({ id: leadVerificationCorrections.id })
    .from(leadVerificationCorrections)
    .where(and(eq(leadVerificationCorrections.validationId, call.id), eq(leadVerificationCorrections.verdict, "corrected")));
  return { made: true, corrections: corrected.length, at: call.at };
}

/**
 * Null where a verification call may be recorded on this lead; otherwise the
 * sentence to refuse with.
 */
export async function callRefusalFor(customerId: string): Promise<string | null> {
  const [lead] = await db
    .select({ stage: customers.leadStage, salesType: customers.leadSalesType })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!lead) return null;
  /* Cheap exits first: most calls are on a lead that is not in Qualification. */
  if (!qualificationAccess(lead.stage).writable || lead.salesType === "distributor") return null;

  const [entered] = await db
    .select({ at: leadStageTransitions.at })
    .from(leadStageTransitions)
    .where(
      and(
        eq(leadStageTransitions.customerId, customerId),
        inArray(leadStageTransitions.toStage, ["qualification", "qualified"]),
      ),
    )
    .orderBy(desc(leadStageTransitions.at))
    .limit(1);

  const saved = await db
    .select({ at: auditLog.at })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "customer"),
        eq(auditLog.entityId, customerId),
        eq(auditLog.action, REVIEW_SAVED_ACTION),
        ...(entered ? [gte(auditLog.at, entered.at)] : []),
      ),
    )
    .limit(1);

  return callAllowed({
    stage: lead.stage,
    salesType: lead.salesType,
    enteredQualificationAt: entered?.at ?? null,
    savedAt: saved.map((s) => s.at),
  })
    ? null
    : CALL_AFTER_REVIEW;
}
