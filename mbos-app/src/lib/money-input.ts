/**
 * An amount TYPED, into paise and back.
 *
 * The collect box took digits only, so a bill of ₹10,450.60 could not be
 * collected exactly: ticking it filled "10451", the forty paise went "on
 * account" as an advance nobody paid, and a bill ending in .40 was left with a
 * residue that never cleared. Money is paise everywhere else in this product;
 * this is the one place a person types it, so the conversion lives here and is
 * tested rather than written inline at each box.
 *
 * Pure — no clock, no store.
 */

/**
 * What a box holds, cleaned as it is typed: digits and at most one point with
 * at most two places after it. Anything else is dropped rather than refused,
 * because a keypad slip should not cost him what he had already typed.
 */
export function cleanAmount(typed: string): string {
  const kept = typed.replace(/[^0-9.]/g, '');
  const dot = kept.indexOf('.');
  if (dot === -1) return kept;
  const whole = kept.slice(0, dot);
  const frac = kept.slice(dot + 1).replace(/\./g, '').slice(0, 2);
  return whole + '.' + frac;
}

/** Paise from what is in the box, or 0 where nothing usable is there. */
export function paiseFromTyped(typed: string): number {
  const clean = cleanAmount(typed);
  if (!clean || clean === '.') return 0;
  const [whole, frac = ''] = clean.split('.');
  const rupees = whole ? parseInt(whole, 10) : 0;
  const paise = frac ? parseInt((frac + '0').slice(0, 2), 10) : 0;
  return rupees * 100 + paise;
}

/**
 * Paise as the box should show them: whole rupees bare, anything else to two
 * places. "10450.60", never "10450.6", because a box reading .6 reads as six
 * paise to somebody counting notes.
 */
export function typedFromPaise(paise: number): string {
  if (paise <= 0) return '';
  const whole = Math.floor(paise / 100);
  const frac = paise % 100;
  return frac ? `${whole}.${String(frac).padStart(2, '0')}` : String(whole);
}
