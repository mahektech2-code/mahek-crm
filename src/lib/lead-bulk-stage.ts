import { REASON_CODE_NEEDING_REMARKS, VERIFICATION_FAILED_CODE, type LeadStage } from "./lead-labels";

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

/**
 * What a PARK asks, once for the whole selection: the same four answers the
 * record's own Park control asks. The next action's OWNER is deliberately not
 * here — each lead's own owner holds it, which the server resolves per lead.
 */
export type BulkHold = {
  /** Free text. Optional, except against the code `other`. */
  remarks: string;
  /** `YYYY-MM-DD` — the day it comes back. */
  resumeDate: string;
  /** What happens when it does. */
  actionText: string;
  /** `YYYY-MM-DD` — when that happens. */
  actionDate: string;
};

export const EMPTY_BULK_HOLD: BulkHold = { remarks: "", resumeDate: "", actionText: "", actionDate: "" };

/**
 * Whether the modal may submit.
 *
 * Anything but Lost and On hold is unchanged. Lost needs a listed code. A park
 * needs a code from `offered` (then the HOLD list), the day it comes back, the
 * next action and its day — and the remarks too where the code is `other`,
 * because `other` answers nothing on its own.
 *
 * The SERVER is the rule (`bulkAdvanceLeadStage` asks the same questions on the
 * same configured list); this only stops the screen offering a press that is
 * certain to be refused.
 */
export function bulkStageReady(
  stage: LeadStage,
  reasonCode: string,
  offered: readonly Coded[],
  hold?: BulkHold,
): boolean {
  if (stage === "on_hold") {
    if (!offered.some((r) => r.code === reasonCode)) return false;
    if (!hold) return false;
    if (reasonCode === REASON_CODE_NEEDING_REMARKS && !hold.remarks.trim()) return false;
    return Boolean(hold.resumeDate && hold.actionText.trim() && hold.actionDate);
  }
  if (stage !== "lost") return true;
  return offered.some((r) => r.code === reasonCode);
}

/** What goes to `bulkAdvanceLeadStage` — a reason and note travel with a loss; a park carries its own answers. */
export function bulkStagePayload(
  customerIds: string[],
  stage: LeadStage,
  reasonCode: string,
  note: string,
  hold?: BulkHold,
): {
  customerIds: string[];
  to: LeadStage;
  reasonCode?: string;
  note?: string;
  hold?: { reason?: string; resumeDate: string };
  nextAction?: { action: string; date: string };
} {
  if (stage === "on_hold" && hold) {
    return {
      customerIds,
      to: stage,
      reasonCode,
      hold: { reason: hold.remarks.trim() || undefined, resumeDate: hold.resumeDate },
      nextAction: { action: hold.actionText.trim(), date: hold.actionDate },
    };
  }
  if (stage !== "lost") return { customerIds, to: stage };
  return { customerIds, to: stage, reasonCode, note: note.trim() || undefined };
}
