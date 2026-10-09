import { VERIFICATION_FAILED_CODE, type LeadStage } from "./lead-labels";

/* ---------------------------------------------------------------------------
 * THE BULK "CHANGE STAGE" MODAL'S LOST RULE — pure, so the button's enabled
 * state and the list it offers can be exercised without a browser.
 *
 * The SERVER is the rule (`evaluateLeadStageMove` refuses a loss without a code
 * from `leads.lostReasons`); this only stops the screen offering a press that
 * is certain to be refused, and never replaces that check.
 * ------------------------------------------------------------------------- */

type Coded = { code: string; label: string };

/**
 * The reasons a person may pick when closing leads by hand. The verification
 * call's own code is theirs alone to write (the Sales Manager pipeline's modal
 * filters it for the same reason), so it is not offered here.
 */
export function pickableLostReasons(configured: readonly Coded[]): Coded[] {
  return configured.filter((r) => r.code !== VERIFICATION_FAILED_CODE);
}

/** Whether the modal may submit: anything but Lost is unchanged, Lost needs a listed code. */
export function bulkStageReady(
  stage: LeadStage,
  reasonCode: string,
  offered: readonly Coded[],
): boolean {
  if (stage !== "lost") return true;
  return offered.some((r) => r.code === reasonCode);
}

/** What goes to `bulkAdvanceLeadStage` — a reason and note only travel with a loss. */
export function bulkStagePayload(
  customerIds: string[],
  stage: LeadStage,
  reasonCode: string,
  note: string,
): { customerIds: string[]; to: LeadStage; reasonCode?: string; note?: string } {
  if (stage !== "lost") return { customerIds, to: stage };
  return { customerIds, to: stage, reasonCode, note: note.trim() || undefined };
}
