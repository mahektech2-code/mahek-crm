/**
 * WHEN A SIGNED-IN HANDSET MUST TAKE THE WHOLE BOOK AGAIN — pure, so it is
 * tested here rather than by installing an APK over another one.
 *
 * A handset takes the full snapshot (`/api/mbos/bootstrap`) exactly once, at
 * sign-in; every pass after that is a delta on `pullCursor`. A delta sends
 * what CHANGED, so anything a new build needs that has not changed on the
 * server since — a configuration key the old build never asked for, a column
 * the old schema had no place for, a channel the old pull did not apply —
 * never reaches the phone. An upgrade does not sign anybody out, so the
 * salesman runs the new screens against the old build's data for the life of
 * the install, and the feature reads as not having shipped.
 *
 * So the build that last took the snapshot is remembered, and a different
 * build takes it again — once, on its first pass with signal, with the token
 * it already holds. "Build" is the APK AND the over-the-air bundle, because an
 * OTA update can bring a screen that reads a key just as an APK can.
 *
 * A snapshot that fails is retried, but not on every tick: it is the largest
 * request this app makes, and a 2G phone retrying it every thirty seconds
 * would spend the battery and the data plan proving the tower is weak.
 */

/** How long after a failed snapshot before the next pass asks again. */
export const REBOOTSTRAP_RETRY_MS = 10 * 60_000;

export function needsRebootstrap(args: {
  /** The build that last applied a snapshot. Null on an install that predates this rule. */
  bootstrappedBuild: string | null;
  currentBuild: string;
  /** When the last attempt failed, or null if it has not. */
  lastFailedAt: number | null;
  now: number;
}): boolean {
  if (args.bootstrappedBuild === args.currentBuild) return false;
  if (args.lastFailedAt != null && args.now - args.lastFailedAt >= 0 && args.now - args.lastFailedAt < REBOOTSTRAP_RETRY_MS) {
    return false;
  }
  return true;
}
