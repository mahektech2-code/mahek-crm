/* ---------------------------------------------------------------------------
 * "What they are ready for" — what a verifying call may do about it.
 *
 * Pure. The three readiness questions already exist and already store free
 * text (`ready_for_trial`, `ready_for_commercial`, `ready_for_order`); until
 * now nothing read them. This file says what a POSITIVE answer means, which of
 * the three can be positive together, and which stage each one asks for.
 *
 * It decides nothing about permission. Whether the move may be made — and
 * whether a closed gate may be passed to make it — is the stage engine's, the
 * `lead.work` / `lead.override` capabilities' and the override setting's, and
 * the service that applies this (`lead-readiness-move-service.ts`) asks all of
 * them. A readiness answer is evidence for a move, never authority for one.
 *
 * ONE CHOICE, NOT THREE. A lead has one next stage. Ready-for-an-order already
 * implies talking rates, and ready-for-rates already implies a trial, so two
 * positives would not be two facts, they would be one fact said twice and an
 * invitation to argue about which stage wins. The screens disable the other
 * rows once one is positive; `readReadiness` is the same rule for a request
 * that did not come through a screen.
 * ------------------------------------------------------------------------- */

import type { LeadStage } from "@/lib/lead-labels";

export type ReadinessChoice = "trial" | "rates" | "order";

/** The question each choice is stored under — stable ids, never renumbered. */
export const READINESS_QUESTION: Readonly<Record<ReadinessChoice, string>> = {
  trial: "ready_for_trial",
  rates: "ready_for_commercial",
  order: "ready_for_order",
};

export const READINESS_QUESTION_IDS: readonly string[] = Object.values(READINESS_QUESTION);

/**
 * A POSITIVE answer. The same conservative reading the Sales Manager desk has
 * always applied to these answers: it starts with yes, y or true. "No", "not
 * yet", "maybe next month" and a blank are all not-positive, and an answer this
 * cannot read is never promoted to a stage move.
 */
export function isPositiveAnswer(value: string | null | undefined): boolean {
  return /^\s*(yes|y|true)\b/i.test(value ?? "");
}

export type ReadinessReading =
  | { ok: true; choice: ReadinessChoice | null }
  | { ok: false; error: string };

/** Which choice the answers make, or why they do not make exactly one. */
export function readReadiness(answers: Readonly<Record<string, string | undefined>>): ReadinessReading {
  const positive = (Object.keys(READINESS_QUESTION) as ReadinessChoice[]).filter((c) =>
    isPositiveAnswer(answers[READINESS_QUESTION[c]]),
  );
  if (positive.length > 1) {
    return {
      ok: false,
      error:
        "Choose one of the three readiness answers: they are one decision about the next step, not three. Say Yes to the furthest one the customer is ready for.",
    };
  }
  return { ok: true, choice: positive[0] ?? null };
}

/**
 * For a screen: whether a readiness row is locked because ANOTHER one is
 * positive. The positive row itself is never locked — clearing it is how the
 * choice is changed.
 */
export function readinessLocked(
  questionId: string,
  answers: Readonly<Record<string, string | undefined>>,
): boolean {
  if (!READINESS_QUESTION_IDS.includes(questionId)) return false;
  return READINESS_QUESTION_IDS.some((other) => other !== questionId && isPositiveAnswer(answers[other]));
}

export type ReadinessTarget = {
  to: LeadStage;
  /** The override reason recorded if a closed gate has to be passed to get there. */
  reasonCode: string;
  /** The sentence the transition and the timeline carry. */
  note: string;
  /** Set on arrival, where the next step is a job somebody owes. */
  nextAction?: string;
};

/**
 * Where each choice goes.
 *
 * Order goes to NEGOTIATION and not to 1st Order: that rung is entered by a real
 * order in the ledger (its own gate demands one), and a readiness answer is not
 * an order. The lead is put where the actual-order confirmation already looks
 * for it, with the job of taking the order.
 */
export const READINESS_TARGET: Readonly<Record<ReadinessChoice, ReadinessTarget>> = {
  trial: {
    to: "sample_trial",
    reasonCode: "readiness_trial",
    note: "Customer ready for a trial — moved on the verification call. The sample still needs its request, approval and dispatch.",
  },
  rates: {
    to: "negotiation",
    reasonCode: "readiness_sample_not_needed",
    note: "Sample not needed — customer ready for rates and terms.",
  },
  order: {
    to: "negotiation",
    reasonCode: "readiness_order",
    note: "Customer ready to place an order — in Negotiation until the actual order is recorded and confirmed.",
    nextAction: "Take the order",
  },
};

/**
 * CONDITIONS NO OVERRIDE MAY PASS ON A READINESS MOVE TO SAMPLE / TRIAL.
 *
 * A trial sends product out of the door, so two approvals are never skipped by
 * a verification call, whoever makes it and whatever the override setting says:
 * the back office's GST validation, and the Sales Manager's review of the
 * Qualification. Each is somebody else's decision; a readiness answer is not.
 */
export const TRIAL_NON_SKIPPABLE: Readonly<Record<string, { pending: string; next: string }>> = {
  gst_verified: {
    pending: "the GST number has not been validated by the back office",
    next: "have the GST number validated",
  },
  manager_review_pending: {
    pending: "the Qualification has not been reviewed and approved by the Sales Manager",
    next: "complete the Qualification and have the Sales Manager review and approve it",
  },
  manager_review_open: {
    pending: "the Sales Manager has sent the Qualification back and it has not been re-reviewed and approved",
    next: "answer the Sales Manager's note so the Qualification can be reviewed and approved",
  },
};

/** The override reasons these moves use, so the evaluator accepts them and the screens can name them. */
export const READINESS_OVERRIDE_REASONS: readonly { code: string; label: string }[] = [
  { code: "readiness_trial", label: "Customer ready for a trial (verification call)" },
  { code: "readiness_sample_not_needed", label: "Sample not needed — customer ready for rates and terms" },
  { code: "readiness_order", label: "Customer ready to place an order (verification call)" },
];

export function readinessReasonLabel(code: string | null | undefined): string | null {
  return READINESS_OVERRIDE_REASONS.find((r) => r.code === code)?.label ?? null;
}
