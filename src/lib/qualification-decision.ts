import { REASON_CODE_NEEDING_REMARKS } from "./lead-labels";
import { SKIP_TO_NEGOTIATION, STAGE_SKIP_REASONS } from "./lead-stage-skip";

/* ---------------------------------------------------------------------------
 * "READY FOR SAMPLE / TRIAL?" — what is asked after Qualification is completed.
 *
 * Pure and client-safe: the dialog draws these and the action validates against
 * them, so a reason a screen offers is a reason the server understands.
 *
 * Yes asks for the move to Sample / Trial. No demands a reason from this list;
 * only the first one moves the lead anywhere (straight to Negotiation, by the
 * rules that already govern skipping the trial). The others record why the lead
 * is staying at Qualification, so "why did these not go to a sample" is a
 * question somebody can ask of a code.
 * ------------------------------------------------------------------------- */

export type DecisionReason = { code: string; label: string };

export const SKIP_REASON: DecisionReason = {
  code: SKIP_TO_NEGOTIATION,
  label: STAGE_SKIP_REASONS.find((r) => r.code === SKIP_TO_NEGOTIATION)!.label,
};

/** The dropdown after "No". The skip is first and is the only one that moves the lead. */
export const NOT_READY_REASONS: readonly DecisionReason[] = [
  SKIP_REASON,
  { code: "customer_declined_sample", label: "The customer does not want a sample" },
  { code: "not_ready_yet", label: "The customer is not ready yet — follow up later" },
  { code: REASON_CODE_NEEDING_REMARKS, label: "Other" },
];

export function decisionReasonLabel(code: string): string | null {
  return NOT_READY_REASONS.find((r) => r.code === code)?.label ?? null;
}
