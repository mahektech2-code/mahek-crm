/* ---------------------------------------------------------------------------
 * §4.1 — HOW HARD TO PUSH A LEAD, which is not how much it is worth.
 *
 * The three words are the same three `customer_potential` already uses, and
 * that is exactly why this file exists rather than the screens reaching for
 * that enum: they answer different questions about the same shop. POTENTIAL is
 * a judgement about the ACCOUNT — what it could spend in a month — and it is
 * the salesman's, captured in the shop at Suspect to Prospect. PRIORITY is a
 * judgement about the WORK — whether this is one of the leads the team should
 * be spending this fortnight on — and it is the MANAGER's. A big shop whose
 * decision maker is abroad until March is high potential and low priority, and
 * a small one that will order next week if somebody rings is the reverse.
 * Collapsing them would make both unreadable, and would hand the manager's
 * word to whoever typed the estimate.
 *
 * PURE AND CLIENT-SAFE, like `lead-labels`, `customer-health` and
 * `seat-labels` beside it. The badge on the list, the control on the record
 * and the filter bar are all client components; the service that reads the
 * column and the action that writes it are `server-only`. A second copy of
 * these three words typed into a screen is the usual way a dropdown comes to
 * offer a value the server has never heard of.
 * ------------------------------------------------------------------------- */

/** Exactly the `lead_priority` pg enum, in the order a manager reads them. */
export const LEAD_PRIORITIES = ["high", "medium", "low"] as const;

export type LeadPriority = (typeof LEAD_PRIORITIES)[number];

/**
 * NULL IS THE FOURTH ANSWER AND IT IS NOT `low`.
 *
 * Nobody has judged this lead. That is a different fact from a manager having
 * looked at it and said it can wait, and the difference is the whole value of
 * the field: "seventy leads nobody has prioritised" is a thing a manager can
 * act on, and "seventy low-priority leads" is a thing they will leave alone.
 * Every lead in the book carries null on the day the column ships and nothing
 * backfills one — a guess written here would assert that somebody decided.
 *
 * It is said in words rather than left as a blank cell, for the same reason
 * "Nobody" is printed in the Owner column: an empty cell reads as missing data
 * rather than as a real answer.
 */
export const NO_PRIORITY_LABEL = "Not set";

const LABELS: Record<LeadPriority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function priorityLabel(priority: LeadPriority | null | undefined): string {
  return priority ? LABELS[priority] : NO_PRIORITY_LABEL;
}

/**
 * The pill's colour, and `low` is deliberately NOT drawn as a fault.
 *
 * A low priority is a manager's decision that has been taken, so it gets the
 * neutral skin — colouring it like an overdue bill would put a warning on
 * every lead somebody has correctly parked. `warn` is saved for the unjudged
 * case, which is the one with something outstanding on it.
 */
export function priorityTone(
  priority: LeadPriority | null | undefined,
): "danger" | "warn" | "brand" | "neutral" {
  switch (priority) {
    case "high":
      return "danger";
    case "medium":
      return "brand";
    case "low":
      return "neutral";
    default:
      return "warn";
  }
}

/** What the badge and the control say under the word, so both say it once. */
export function prioritySentence(priority: LeadPriority | null | undefined): string {
  switch (priority) {
    case "high":
      return "Work this one first.";
    case "medium":
      return "Worth the ordinary cadence.";
    case "low":
      return "Real, and not this fortnight's work.";
    default:
      return "Nobody has judged how hard to push this one.";
  }
}

/** Narrow whatever arrived off a URL or a form to the enum, or to null. */
export function asLeadPriority(value: unknown): LeadPriority | null {
  return LEAD_PRIORITIES.includes(value as LeadPriority) ? (value as LeadPriority) : null;
}
