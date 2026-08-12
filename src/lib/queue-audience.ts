/**
 * WHO the Call Log is showing, as opposed to WHY a call is due.
 *
 * The two are different axes and the screen keeps them apart: this narrows the
 * book to leads or to existing customers, and the reason pills then work
 * within it. Folding them into one row of pills made "Leads" look like an
 * alternative to "Payment due" when it is a cut across all of them — and left
 * no way at all to ask for the other half of the book.
 *
 * Pure and client-safe: the screen that draws the control and the page that
 * reads the cookie share this, the way `lib/modules.ts` is shared by the
 * review table and the route guard.
 */

export type QueueAudience = "all" | "leads" | "customers";

export const QUEUE_AUDIENCE_COOKIE = "mahekone_queue_audience";

/**
 * A standing fact about how somebody works — one telecaller lives on the
 * existing book, another is put on new leads — so it is remembered, unlike the
 * reason pills, which answer "what am I doing right now" and reset.
 */
export function parseQueueAudience(value: string | undefined): QueueAudience {
  return value === "leads" || value === "customers" ? value : "all";
}

/** How the narrowing is said on screen, including in an empty state. */
export function audienceLabel(audience: QueueAudience): string {
  return audience === "leads"
    ? "leads"
    : audience === "customers"
      ? "existing customers"
      : "customers";
}
