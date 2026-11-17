import "server-only";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customers, leadStageTransitions } from "@/db/schema";
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

/**
 * Has the Sales Manager saved the ONE review of this Prospect? The call is offered
 * after that save in the one-review flow just as it is at Qualification, but it is
 * not refused before it: at Prospect a call is still the alternative way of
 * verifying, and nothing here may block the doors that use it.
 */
export async function combinedReviewSaved(customerId: string): Promise<boolean> {
  const [entered] = await db
    .select({ at: leadStageTransitions.at })
    .from(leadStageTransitions)
    .where(and(eq(leadStageTransitions.customerId, customerId), eq(leadStageTransitions.toStage, "prospect")))
    .orderBy(desc(leadStageTransitions.at))
    .limit(1);
  const rows = await db
    .select({ id: auditLog.id })
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
  return rows.length > 0;
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
