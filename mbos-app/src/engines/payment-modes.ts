/**
 * Which payment modes the collection form offers. Pure, so it is tested
 * without a phone; the list itself is the office's `payments.modes`.
 */

/** What this phone offers when the office has not said — the four it always had. */
export const FALLBACK_MODES: readonly string[] = ['Cash', 'Cheque', 'UPI', 'Bank transfer'];

/**
 * The two modes in `payments.modes` that are not money ARRIVING.
 *
 * An adjustment settles a bill against something already on the account and a
 * credit note against goods returned or a claim allowed. Both are accounts'
 * decisions, taken at a desk against the ledger; a salesman at a counter has
 * nothing in his hand that either could describe, and a "credit note" typed
 * into the collection form would put money in his cash-in-hand that no bank
 * will ever show.
 */
export const DESK_ONLY_MODES: readonly string[] = ['Adjustment', 'Credit note'];

/** The office's list, minus the desk's own two, or the fallback if nothing is left. */
export function fieldModes(fromOffice: unknown): string[] {
  const list = Array.isArray(fromOffice) ? fromOffice.filter((m): m is string => typeof m === 'string' && m.trim().length > 0) : [];
  const usable = list.filter((m) => !DESK_ONLY_MODES.some((d) => d.toLowerCase() === m.trim().toLowerCase()));
  return usable.length ? usable : [...FALLBACK_MODES];
}
