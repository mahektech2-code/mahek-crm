/* ---------------------------------------------------------------------------
 * One result in an app's header search — pure and client-safe, because the
 * search box that draws it is a client component and the services that build
 * it are server-only.
 *
 * The ERP's header search answered with one flat list, every row naming what
 * kind of thing it is, and that is the shape every app's box now shares: a
 * customer, a lead, a bill, an order, a salesman, a screen. A row with no
 * `href` and no `quick` is information only (a product: "do we sell it, in
 * what pack") and is drawn but not clickable.
 * ------------------------------------------------------------------------- */

export type SearchHit = {
  /** What it is, in a word or two: "Customer", "Lead", "Bill", "Screen". */
  kind: string;
  name: string;
  /** The line under the name: city, phone, amount, status. */
  meta: string;
  /** Where choosing it goes. */
  href?: string;
  /** A customer id to open in the app's own quick view instead of navigating. */
  quick?: string;
};

/** The order a search's kinds are drawn in — people and records first, screens last. */
export const KIND_ORDER = [
  "Salesman",
  "Customer",
  "Third party",
  "Lead",
  "Order",
  "Bill",
  "Complaint",
  "Product",
  "Screen",
];

/**
 * Whether what was typed reads as a QUESTION rather than a name — so the box
 * puts "Ask AI" first and Enter asks it. A trailing "?" always does; so do the
 * question words people start a sentence with. A shop called "How Paints" is
 * a hit either way: the question row is offered, never forced.
 */
export function looksLikeQuestion(q: string): boolean {
  const t = q.trim().toLowerCase();
  if (t.length < 3) return false;
  if (t.endsWith("?")) return true;
  if (t.split(/\s+/).length < 3) return false;
  return /^(who|whom|whose|what|which|when|where|why|how|is|are|do|does|did|can|show|list|tell|give|find|kis|kaun|kya|kitne|kitna|kab|kaise)\b/.test(t);
}
