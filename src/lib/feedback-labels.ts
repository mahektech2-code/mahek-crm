/* ---------------------------------------------------------------------------
 * The vocabulary of feedback: pure, and client-safe.
 *
 * A stored enum is not a label. `in_progress` reaching a screen unchanged is
 * the same fault `packaging_damage` was, and the form that WRITES these runs
 * in the browser — so the way from a stored value to a sentence cannot live
 * beside a `server-only` import.
 * ------------------------------------------------------------------------- */

export const FEEDBACK_KINDS = ["bug", "suggestion", "feature", "question"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_STATUSES = ["new", "in_progress", "done", "declined"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** What each kind is called on a form, where the person is choosing one. */
export const KIND_LABELS: Record<FeedbackKind, string> = {
  bug: "Something is broken",
  suggestion: "Suggestion",
  feature: "Feature request",
  question: "Question",
};

/** The short form, for a badge in a table where the row says the rest. */
export const KIND_SHORT: Record<FeedbackKind, string> = {
  bug: "Bug",
  suggestion: "Suggestion",
  feature: "Feature",
  question: "Question",
};

export const STATUS_LABELS: Record<FeedbackStatus, string> = {
  new: "New",
  in_progress: "Being looked at",
  done: "Done",
  declined: "Not doing",
};
