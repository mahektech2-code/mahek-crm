/**
 * WHICH SEAT MOVED, in words.
 *
 * A stored enum is not a label, and this one had been a ternary chain whose
 * final arm was "Back office" — so the day a fourth seat was added, its
 * history lines would have rendered as back office changes. Silently, and on
 * the one screen somebody reads to find out what happened to an account. The
 * type checker caught it because the chain lived beside a hardcoded union;
 * a `Record` keyed by the enum cannot be extended without being completed.
 *
 * Pure and client-safe, like `complaint-labels`, `feedback-labels` and
 * `next-step-labels` before it: the record screen is a client component, and a
 * second copy typed into it would drift — the half that drifts is always the
 * half somebody reads.
 */
export type AmRole = "sales" | "sales_manager" | "back_office" | "relationship";

export const SEAT_LABELS: Record<AmRole, string> = {
  sales: "Sales",
  sales_manager: "Sales manager",
  back_office: "Back office",
  /*
   * Not "Relationship owner". The line already reads
   * "<from> → <to>", so the noun is carried by the arrow; what the label has
   * to say is which of an account's seats this line is about.
   */
  relationship: "Relationship",
};

/** Falls back to the stored value rather than to a wrong seat's name. */
export function seatLabel(role: string): string {
  return SEAT_LABELS[role as AmRole] ?? role;
}
