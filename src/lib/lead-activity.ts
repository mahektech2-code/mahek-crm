/* ---------------------------------------------------------------------------
 * LEAD ACTIVITY — the vocabulary of a Call and a Visit logged by hand, and the
 * rule that merges them into one history. PURE and client-safe: the dialogs
 * that write these run in a browser and the service that reads them is
 * `server-only`, so the words cannot live beside the database.
 *
 * THREE KINDS OF CALL, ONE HISTORY. A `calls` row on a lead is one of:
 *   • a QUALIFICATION call — Call 1, 2 or 3 of the Calling Desk's rule, marked
 *     in `outcome_detail.qualCall`. It is counted, capped and gated, and it is
 *     written ONLY by `logQualificationCall`.
 *   • a GENERAL call — any other conversation with the lead, logged by hand.
 *     Marked `outcome_detail.activity = "general_call"`. It is never counted
 *     towards the three and can never spend one, which is the whole point of
 *     keeping the two apart: logging "rang to say hello" must not use up a
 *     qualification call or hide that one is still owed.
 *   • a call the CRM's own call panel wrote (no mark at all).
 *
 * A VISIT logged from the web is an `mbos_visits` row with no `device_id` — the
 * handset always sends one — so there is one visit table, one count towards
 * the Suspect cap, and no second history to reconcile. It is never verified:
 * nothing about where the person stood was checked, and the row says so in
 * words rather than leaving a manager to wonder.
 * ------------------------------------------------------------------------- */

/** What `outcome_detail.activity` carries on a call logged by hand. */
export const GENERAL_CALL = "general_call";

export type GeneralCallOutcome = "spoke" | "callback" | "no_answer" | "not_interested";

export const GENERAL_CALL_OUTCOMES: readonly { code: GeneralCallOutcome; label: string; hint: string }[] = [
  { code: "spoke", label: "Spoke — nothing more to do", hint: "A conversation that needs no follow-up." },
  { code: "callback", label: "Spoke — call back", hint: "Reached them; there is a follow-up to make." },
  { code: "no_answer", label: "No answer", hint: "Rang, but nobody spoke to us." },
  { code: "not_interested", label: "Not interested", hint: "They said no." },
] as const;

/** The CRM's own coarse outcome for the `calls` row (nine values, none of these). */
export function crmOutcomeForGeneral(
  outcome: GeneralCallOutcome,
): "casual_talk" | "follow_up" | "no_answer" | "not_interested" {
  switch (outcome) {
    case "spoke":
      return "casual_talk";
    case "callback":
      return "follow_up";
    case "no_answer":
      return "no_answer";
    case "not_interested":
      return "not_interested";
  }
}

export type VisitOutcome = "visited" | "order" | "payment" | "complaint" | "sample" | "not_available" | "closed";

/** The same seven the handset records, worded for somebody at a desk. */
export const VISIT_OUTCOMES: readonly { code: VisitOutcome; label: string }[] = [
  { code: "visited", label: "Visited" },
  { code: "not_available", label: "Not available" },
  { code: "closed", label: "Shop closed" },
  { code: "order", label: "Order discussed" },
  { code: "sample", label: "Sample discussed" },
  { code: "payment", label: "Payment discussed" },
  { code: "complaint", label: "Complaint raised" },
] as const;

export function visitOutcomeLabel(code: string): string {
  return VISIT_OUTCOMES.find((o) => o.code === code)?.label ?? code;
}

/** Said on every manually logged visit, and on the history row. */
export const WEB_VISIT_UNVERIFIED = "Logged by hand — no location, check-in or duration is recorded.";

export type ActivityKind = "qualification_call" | "general_call" | "call" | "visit";

export type ActivityRow = {
  /** `call:<id>` or `visit:<id>` — unique across the two tables. */
  key: string;
  type: "call" | "visit";
  kind: ActivityKind;
  /** ISO instant. */
  at: string;
  /** Who performed it. Null when the account is gone. */
  byId: string | null;
  byName: string | null;
  /** "Qualification call 2 of 3", "Call", "Visit". */
  title: string;
  outcome: string | null;
  notes: string | null;
  /** A day (yyyy-mm-dd) the person said they would follow up, or null. */
  followUpDate: string | null;
  followUpText: string | null;
  /** Where it was recorded: the handset, the desk, or typed in on the web. */
  source: "handset" | "desk" | "web";
  /** A visit whose location was not checked says so; null for calls. */
  note: string | null;
};

/** Newest first, ties broken by key so two rows at one instant never swap. */
export function mergeActivity(rows: readonly ActivityRow[]): ActivityRow[] {
  return [...rows].sort((a, b) => {
    const d = Date.parse(b.at) - Date.parse(a.at);
    if (d !== 0) return d;
    return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
  });
}
