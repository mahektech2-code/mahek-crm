/* ---------------------------------------------------------------------------
 * The console's vocabulary. PURE, and deliberately not a client module.
 *
 * `parts.tsx` is `"use client"` because it draws things. These do not draw
 * anything — they turn a count into a phrase and a stored enum into a label —
 * and a server component that imported them from there got "Attempted to call
 * plural() from the server", which is a runtime 500 rather than a type error.
 *
 * The same reasoning that gives `lib/complaint-labels.ts` and
 * `lib/feedback-labels.ts` their own files: a label is not a server's business
 * and not a component either.
 * ------------------------------------------------------------------------- */

/** Count, noun and verb agree at every value. */
export function plural(n: number, noun: string, pl?: string): string {
  return `${n} ${n === 1 ? noun : (pl ?? `${noun}s`)}`;
}

/** Waiting a day is worth saying out loud; waiting an hour is not. */
export function waitingWords(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h waiting`;
  const days = Math.floor(hours / 24);
  return `${plural(days, "day")} waiting`;
}

/** The enum's word, in the reader's. A stored value is not a label. */
export const APPROVAL_LABEL: Record<string, string> = {
  order: "Order over limit",
  expense_claim: "Expense claim",
  leave: "Leave",
  tour: "Tour",
  sample: "Sample",
  attendance_regularisation: "Attendance correction",
};

export const VISIT_OUTCOME_LABEL: Record<string, string> = {
  visited: "Visited",
  order: "Order taken",
  payment: "Payment collected",
  complaint: "Complaint",
  sample: "Sample required",
  not_available: "Not available",
  closed: "Shop closed",
};

export const LEAVE_LABEL: Record<string, string> = {
  casual: "Casual",
  sick: "Sick",
  earned: "Earned",
  loss_of_pay: "Loss of pay",
};

export function label(map: Record<string, string>, value: string): string {
  return map[value] ?? value.replace(/_/g, " ");
}
