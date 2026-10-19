/**
 * A quantity TYPED, for everything that is not money — litres, kilometres,
 * kilograms, percentages — and the whole-number boxes beside them.
 *
 * Every one of these boxes used `number-pad` and `replace(/[^0-9]/g, '')`, so
 * "30.5 litres" was stored as 305: the point was dropped and the digits either
 * side of it were joined. That is worse than refusing the figure, because the
 * wrong one looks exactly like a right one. Money has its own file,
 * `money-input.ts`, because it ends in paise; this is the same cleaning for
 * figures that stay as numbers.
 *
 * Pure — no clock, no store.
 */

/**
 * What a decimal box holds, cleaned as it is typed: digits and at most one
 * point with at most `places` digits after it. Commas are dropped as thousands
 * separators, the same reading `cleanAmount` gives a pasted "1,200.50".
 */
export function cleanDecimal(typed: string, places: number): string {
  const kept = typed.replace(/[^0-9.]/g, '');
  const dot = kept.indexOf('.');
  if (dot === -1) return kept;
  const whole = kept.slice(0, dot);
  const frac = kept.slice(dot + 1).replace(/\./g, '').slice(0, places);
  return whole + '.' + frac;
}

/** The number in a decimal box, or null where nothing usable is there. */
export function parseDecimal(typed: string): number | null {
  const clean = cleanDecimal(typed, 20);
  if (!clean || clean === '.') return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

/**
 * A stored figure back into its box without losing the fraction: 30.5 reads
 * "30.5", never "31" — a box that rounds on the way in turns every edit into a
 * correction nobody asked for. Floating-point dust is trimmed at `places`.
 */
export function typedFromDecimal(n: number | null | undefined, places: number): string {
  if (n == null || !Number.isFinite(n)) return '';
  return String(Number(n.toFixed(places)));
}

/**
 * What a WHOLE-number box holds — cans, boxes, days, counts.
 *
 * The point is KEPT once it is typed, and nothing after it is: "1.5" reads
 * "1.", never "15". Dropping the point itself is what joined the digits —
 * each keystroke is cleaned on its own, so "1" then "." then "5" arrived as
 * "1", "1", "15". A trailing point is the box visibly not taking the half,
 * and `wholeOnly` is the sentence that goes under it.
 */
export function cleanWhole(typed: string): string {
  const kept = typed.replace(/[^0-9.]/g, '');
  const dot = kept.indexOf('.');
  return dot === -1 ? kept : kept.slice(0, dot + 1);
}

/** The whole number in a whole-number box — the part before any point — or null. */
export function parseWhole(typed: string): number | null {
  const digits = cleanWhole(typed).replace('.', '');
  return digits ? parseInt(digits, 10) : null;
}

/** True where somebody tried to type a fraction into a whole-number box. */
export function wholeOnly(typed: string | null | undefined): boolean {
  return !!typed && typed.includes('.');
}
