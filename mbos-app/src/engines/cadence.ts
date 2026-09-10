/**
 * How often a trail fix is worth keeping.
 *
 * PURE, and in `engines/` rather than inside `sync/trail.ts`, for the reason
 * the whole fix exists: this is the ONLY place the cadence is actually
 * enforced, and a rule that cannot be tested is a rule nobody can be sure of.
 * `trail.ts` imports expo-location and TaskManager at module scope, so nothing
 * in it can be exercised without a device — which is how a cadence that had
 * silently collapsed to three seconds ran in production for three days.
 *
 * The two settings that look like they do this job do not. `timeInterval`
 * never reaches Android at all — expo-location reads it out of persisted JSON
 * options with a strict `as? Long`, `org.json` hands back a boxed `Integer`,
 * and the override is dropped without a word. `deferredUpdatesInterval` does
 * arrive, and is bypassed outright while the app is in the foreground. So the
 * decision is made here, in JavaScript, where no cast can lose it.
 */

/**
 * `at` is the fix's own timestamp, `lastKeptAt` the mark left by the last one
 * that was written, and `gapMs` the configured spacing.
 *
 * A mark of 0 — nothing kept yet — always keeps: the first fix of a day is the
 * one that says he set off.
 */
export function shouldKeepFix(args: {
  at: number;
  lastKeptAt: number;
  gapMs: number;
}): boolean {
  const { at, lastKeptAt, gapMs } = args;
  if (!Number.isFinite(lastKeptAt) || lastKeptAt <= 0) return true;

  const since = at - lastKeptAt;
  /*
   * A CLOCK THAT HAS GONE BACKWARDS RESETS RATHER THAN STALLS.
   *
   * `since < 0` means the mark is in a future this phone no longer believes
   * in — its time was corrected, or the fix arrived from a batch taken before
   * the correction. Treating that as "too soon" would take no fixes at all
   * until the clock caught up, which on a handset corrected by an hour is an
   * hour of somebody's day missing with nothing anywhere saying why.
   */
  if (since < 0) return true;

  return since >= gapMs;
}
