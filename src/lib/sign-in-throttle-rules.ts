/* ---------------------------------------------------------------------------
 * When a run of wrong passwords stops being answered. PURE, so the rule is
 * tested without a database; `services/sign-in-throttle.ts` does the asking.
 *
 * The window slides. With a limit of five in fifteen minutes, the question is
 * whether the FIFTH most recent failure is less than fifteen minutes old — if
 * it is, five have landed inside the window and the door stays shut until
 * that fifth one ages out, which is the moment the count falls back to four.
 * One timestamp answers both "is it shut" and "for how long", which is why
 * the service asks for exactly that row and nothing else.
 * ------------------------------------------------------------------------- */

/**
 * Minutes until sign-in opens again, or null when it is open.
 *
 * `nthNewest` is the failure at position `limit` counting from the newest —
 * null when there have not been that many inside the window at all.
 */
export function minutesShut(nthNewest: Date | null, windowMinutes: number, now: Date): number | null {
  if (!nthNewest) return null;
  const opensAt = nthNewest.getTime() + windowMinutes * 60_000;
  const left = opensAt - now.getTime();
  if (left <= 0) return null;
  // Rounded UP: "wait 0 minutes" on a door that is still shut reads as a bug.
  return Math.max(1, Math.ceil(left / 60_000));
}

/**
 * The sentence a refused sign-in shows. Never says whether the account exists.
 * The way round it is named only where it exists: offering a phone code on a
 * deployment with none set up sends somebody looking for a button that is not
 * there.
 */
export function shutMessage(minutes: number, codeSignIn: boolean): string {
  const span = minutes === 1 ? "a minute" : `${minutes} minutes`;
  const way = codeSignIn ? ", or sign in with a code sent to your phone" : ", or reset your password";
  return `Too many wrong passwords. Try again in ${span}${way}.`;
}
