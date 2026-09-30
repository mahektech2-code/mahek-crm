/* ---------------------------------------------------------------------------
 * The back-office calling desk (spec §14.2), PURE.
 *
 * Three questions every calling screen asks the same way: what the desk
 * suggests doing with a customer, which tab a calling row sits on, and which
 * customers "Take follow-up" puts on my list. The customer record, the calling
 * screen and the tests all read these, so a customer cannot be "follow up" on
 * one screen and "deactivate" on the other.
 * ------------------------------------------------------------------------- */

import { addDaysISO } from "../time";

export const CALLING_STATUSES = ["Call Not Pick Up", "Order Received", "No Requirement", "Reminder Call Back"] as const;
export type CallingStatus = (typeof CALLING_STATUSES)[number];

export const NOT_PICKED = "Call Not Pick Up";
export const ORDER_RECEIVED = "Order Received";

export type SuggestionCfg = { factor: number; threshold: number };
export const DEFAULT_SUGGESTION: SuggestionCfg = { factor: 7, threshold: 7 };

export type Suggestion = "Do FollowUp" | "Do Deactivate This Customer";

/**
 * A29/A32: calls − factor × orders ≤ threshold → keep following up, else
 * the calls are not turning into orders and the customer is worth closing.
 * A fixed rule the source called "A.I Suggetion"; labelled "Suggestion" here.
 */
export function suggestion(calls: number, orders: number, cfg: SuggestionCfg = DEFAULT_SUGGESTION): Suggestion {
  return calls - cfg.factor * orders <= cfg.threshold ? "Do FollowUp" : "Do Deactivate This Customer";
}

/** Orders on the calling desk: rows whose status is Order Received (A29 — the source's typo made this always 0). */
export function totalOrders(rows: readonly { status: string | null }[]): number {
  return rows.filter((r) => (r.status ?? "").trim() === ORDER_RECEIVED).length;
}

export type CallingTab = "To call" | "Follow-ups due" | "History" | "Older";

/**
 * Which tab a row belongs to (spec §14.2): not yet called; a follow-up that
 * has come due with no second status; called within the history window; or
 * older than that. First match wins, in that order.
 */
export function callingTab(
  r: { date: string; status: string | null; secondStatus: string | null; followUp: string | null },
  today: string,
  historyDays: number,
): CallingTab {
  if (!(r.status ?? "").trim()) return "To call";
  if (r.followUp && r.followUp <= today && !(r.secondStatus ?? "").trim()) return "Follow-ups due";
  if (r.date >= addDaysISO(today, -historyDays)) return "History";
  return "Older";
}

/** The "Log call" validations, in the source's words. Null when the call may be saved. */
export function checkCall(
  v: { status: string; second: string; followUp: string },
  today: string,
): { field: string; message: string } | null {
  if (!(CALLING_STATUSES as readonly string[]).includes(v.status)) return { field: "status", message: "Calling status is required" };
  if (v.status === NOT_PICKED && !(CALLING_STATUSES as readonly string[]).includes(v.second))
    return { field: "second", message: "2nd calling status is required when the call is not picked up" };
  if (v.followUp && v.followUp < today) return { field: "followUp", message: "INVALID" };
  return null;
}

export type FollowUpCandidate = {
  id: string;
  /** The customer's area, falling back to the city. */
  area: string | null;
  active: boolean;
  /** Back office is the signed-in person. */
  mine: boolean;
};

const norm = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();

/**
 * Take follow-up (spec §14.2, A34): every active customer of this area whose
 * back office is me, except any already in a calling row today — the source
 * checked only the customer pressed on and then copied the whole area, so a
 * second press doubled the list. A customer still waiting on an open (never
 * called) row is skipped too: putting them on the list again says nothing new.
 */
export function followUpSelection(
  area: string | null,
  customers: readonly FollowUpCandidate[],
  calledToday: ReadonlySet<string>,
  open: ReadonlySet<string> = new Set(),
): string[] {
  const a = norm(area);
  if (!a) return [];
  return customers.filter((c) => c.active && c.mine && norm(c.area) === a && !calledToday.has(c.id) && !open.has(c.id)).map((c) => c.id);
}
