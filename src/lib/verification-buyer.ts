/* ---------------------------------------------------------------------------
 * Whether the verification call has a buyer to check.
 *
 * Pure, and it compares the two STORED values (`customers.lead_buyer` and
 * `customers.lead_decision_maker`), never anything formatted for a screen. A
 * label can be reworded, truncated or decorated; the stored name is what the
 * salesman actually typed.
 *
 * "The same person" is judged on the text with case and spacing folded:
 * "Ramesh  Patel" and "ramesh patel" are one man. Nothing cleverer is attempted
 * — a nickname or a surname-first spelling is a different string and the buyer
 * is then offered for checking, which costs one extra question rather than a
 * silently skipped one.
 *
 * No buyer recorded means nothing to check. A buyer with no decision maker on
 * record is checked: there is no one it could be a duplicate of.
 * ------------------------------------------------------------------------- */

const fold = (v: string | null | undefined): string =>
  (v ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

export function buyerNeedsCheck(
  buyer: string | null | undefined,
  decisionMaker: string | null | undefined,
): boolean {
  const b = fold(buyer);
  if (!b) return false;
  return b !== fold(decisionMaker);
}
