import { REASON_CODE_NEEDING_REMARKS } from "./lead-labels";

/**
 * WHY A SALES MANAGER MOVED A LEAD PAST SAMPLE / TRIAL. A controlled list so
 * "how many leads skipped the trial, and why" is a question somebody can ask of
 * a code. These are starting wordings: `leads.stageSkipReasons` is configuration
 * and the Settings screen is where Mahek rewords them. `other` demands the
 * sentence (`REASON_CODE_NEEDING_REMARKS`).
 *
 * Its own file rather than beside `HOLD_REASONS` in `lead-labels.ts`, because
 * that file is mirrored byte for byte onto the handset and a Sales Manager's
 * choice made at a desk is not something a phone asks.
 */
export const STAGE_SKIP_REASONS: readonly { code: string; label: string }[] = [
  { code: "knows_product", label: "They already know and use our product" },
  { code: "sample_not_needed", label: "A sample is not needed for this shop" },
  { code: "trial_done_outside", label: "The trial was done outside the system" },
  { code: "ready_to_negotiate", label: "They are ready to talk price now" },
  { code: REASON_CODE_NEEDING_REMARKS, label: "Other" },
] as const;
