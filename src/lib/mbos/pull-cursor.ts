/**
 * WHERE THE NEXT PULL STARTS FROM — pure, so the two rules that decide it are
 * tested rather than trusted.
 *
 * THE OVERLAP. The cursor used to be `now`, read at the top of the pull. A
 * write in the office whose transaction started before that instant and
 * committed after the pull's own reads stamps a row with an `updated_at` BELOW
 * the cursor — so the next pull asks for `> cursor` and never sees it. A long
 * sheet projection makes that likely rather than theoretical. Stepping the
 * cursor back a little re-sends the last couple of minutes on every pass, and
 * every channel the handset applies is an idempotent upsert, so the cost is a
 * few repeated rows and the gain is a write that cannot fall through the gap.
 *
 * THE CLAMP. A channel capped at a page size that comes back FULL has rows past
 * its last one that this pull did not send. With the cursor at `now` they fell
 * behind it and were never asked for again — the rule the tombstones already
 * kept, and that every other capped channel broke. So the cursor is held at the
 * last row of the earliest full page, a millisecond before it, so that rows
 * sharing its exact instant come again rather than being skipped.
 */

/** How far back every cursor is stepped, in milliseconds. */
export const CURSOR_OVERLAP_MS = 2 * 60 * 1000;

export function nextPullCursorAt(
  now: Date,
  /** The ordering instant of the last row of each capped page that came back
      FULL; null for a page that was not full. */
  fullPageLastAts: (Date | null | undefined)[],
  overlapMs = CURSOR_OVERLAP_MS,
): Date {
  let at = now.getTime() - overlapMs;
  for (const last of fullPageLastAts) {
    if (!last) continue;
    const t = last.getTime();
    if (Number.isNaN(t)) continue;
    at = Math.min(at, t - 1);
  }
  return new Date(at);
}
