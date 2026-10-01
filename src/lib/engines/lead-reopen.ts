import { VERIFICATION_FAILED_CODE, stageLabel, type LeadSalesType, type LeadStage } from "../lead-labels";
import { ladderFor, isOnTheBookAt, promotesToCustomerAt } from "./lead-ladder";

/* ---------------------------------------------------------------------------
 * REOPENING A LOST LEAD — the rule for WHERE it comes back, and nothing else.
 *
 * PURE, like every engine here, and client-safe: the dialog draws the target
 * from the same function the server writes it with, so the sentence "this lead
 * will go back to Qualification" and the move that follows cannot disagree.
 *
 * A reopen is not a move along a ladder — `lost` is on none, which is why
 * `directionOf` refuses every move out of it — so it is its own act with its
 * own rule, and once the lead is back on a rung every ordinary gate applies to
 * it again. Nothing here opens a gate, and nothing here promotes: a lead that
 * had got as far as the rung that makes it a customer comes back one rung
 * BELOW it, because "was further along once" is not a reason to skip the work
 * that rung demands.
 * ------------------------------------------------------------------------- */

/** What the transition's note begins with — how a reader (and a filter) tells a reopen from any other move. */
const REOPEN_NOTE_PREFIX = "Reopened from Lost";

/** Why this rung and not the one it was lost from, in words a dialog can print. */
export type ReopenBasis =
  | "same_rung"
  | "verification_failed"
  | "ladder_changed"
  | "no_record"
  | "on_the_book";

export type ReopenTarget = { stage: LeadStage; basis: ReopenBasis; explains: string };

/**
 * The rung a Lost lead returns to.
 *
 * - Lost from a rung still on its ladder: that rung — `from_stage` of the
 *   closing transition.
 * - Lost by a FAILED VERIFICATION: Prospect, which is where the verification
 *   call lives, and never further. The verification state is reset by the
 *   service so it is asked again rather than assumed.
 * - Lost from a rung its ladder no longer has (the sales type changed since),
 *   from `on_hold`, or with no closing transition on record at all (a legacy
 *   lead): the FOOT of its ladder. That is a valid starting state, which is
 *   what was asked for instead of an invalid one.
 * - Lost from the rung that makes it a customer or beyond: the rung below it.
 */
export function reopenTarget(input: {
  lostFrom: LeadStage | null | undefined;
  salesType: LeadSalesType | null | undefined;
  lostReason: string | null | undefined;
}): ReopenTarget {
  const ladder = ladderFor(input.salesType);
  const foot = ladder[0];

  if (input.lostReason === VERIFICATION_FAILED_CODE) {
    const stage = ladder.includes("prospect") ? ("prospect" as LeadStage) : foot;
    return {
      stage,
      basis: "verification_failed",
      explains: `It was lost on a failed verification, so it returns to ${stageLabel(stage)} and is verified again.`,
    };
  }

  const from = input.lostFrom;
  if (!from) {
    return {
      stage: foot,
      basis: "no_record",
      explains: `No earlier rung is on record, so it starts again at ${stageLabel(foot)}.`,
    };
  }
  if (!ladder.includes(from)) {
    return {
      stage: foot,
      basis: "ladder_changed",
      explains: `${stageLabel(from)} is no longer a rung on this lead's ladder, so it starts again at ${stageLabel(foot)}.`,
    };
  }
  if (isOnTheBookAt(from, input.salesType)) {
    const at = ladder.indexOf(promotesToCustomerAt(input.salesType));
    const below = at > 0 ? ladder[at - 1] : foot;
    return {
      stage: below,
      basis: "on_the_book",
      explains: `It had reached ${stageLabel(from)}. It returns to ${stageLabel(below)} and must earn the next rung again.`,
    };
  }
  return {
    stage: from,
    basis: "same_rung",
    explains: `It returns to ${stageLabel(from)}, the rung it was lost from.`,
  };
}

/** The sentence written onto the new transition: it must say it was a reopen, and why. */
export function reopenNote(input: {
  reasonLabel: string;
  note?: string | null;
  restoredFromArchive?: boolean;
  previousLostReason?: string | null;
}): string {
  const parts = [`${REOPEN_NOTE_PREFIX} — ${input.reasonLabel}`];
  if (input.note?.trim()) parts.push(input.note.trim());
  if (input.previousLostReason) parts.push(`Previously lost: ${input.previousLostReason}`);
  if (input.restoredFromArchive) parts.push("Restored from the archive");
  return parts.join(" · ");
}

/** A transition that took a lead out of Lost. The only door out of it is a reopen. */
export function isReopenTransition(t: {
  fromStage: string | null;
  toStage: string;
}): boolean {
  return t.fromStage === "lost" && t.toStage !== "lost";
}
