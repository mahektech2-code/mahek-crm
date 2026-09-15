import { test } from 'node:test';
import assert from 'node:assert/strict';

import { trailVerdict } from './trail-watchdog';

/**
 * The watchdog, pinned.
 *
 * It exists because a handset in production answered "background tracking
 * started" and then delivered nothing for the life of the installation, and
 * nothing anywhere could tell. Both directions are worth the assertions: a rule
 * that never fires leaves the field exactly as it was, and one that fires too
 * readily takes a perfectly good handset off the real background task.
 */

const FIVE_MIN = 5 * 60_000;
const MISSES = 4;
const T = 1_700_000_000_000;
/* The shipped floor. Left at the default in the shared helper so the existing
   assertions below keep measuring what they were written to measure: at a
   five-minute cadence the multiplier wins (20 min > 5 min) and the floor is
   not in play at all. */
const MIN_SILENCE = 5 * 60_000;

const verdict = (over: Partial<Parameters<typeof trailVerdict>[0]>) =>
  trailVerdict({
    now: T,
    startedAt: T,
    lastKeptAt: 0,
    gapMs: FIVE_MIN,
    silentCadences: MISSES,
    minSilenceMs: MIN_SILENCE,
    ...over,
  });

/* ---------------------------------------------------------------------------
 * THE REGRESSION THIS FLOOR EXISTS FOR.
 *
 * The window was `gapMs * silentCadences` and nothing else, which was right by
 * coincidence: five minutes times four is twenty, and twenty minutes of
 * silence is a killed service. Correcting the cadence to three seconds — the
 * change that made the trail road-by-road — turned the same multiplication
 * into TWELVE SECONDS, and the penalty for crossing it is that
 * `fallBackToFloor()` abandons real background tracking for the rest of the
 * process. So the watchdog switched tracking off on healthy handsets about a
 * minute after check-in, and the office read "his phone stopped the tracker",
 * which was true and was this rule's own doing.
 * ------------------------------------------------------------------------- */

test('a dense cadence does not shrink the window to nothing', () => {
  const THREE_S = 3_000;
  /* Twelve seconds — four misses of the shipped cadence. Before the floor this
     was 'stalled', which is the whole bug: a walk indoors clears twelve
     seconds, and a 24-second gap was measured on a handset whose trail was
     otherwise perfect. */
  assert.equal(
    verdict({ gapMs: THREE_S, now: T + 12_000 }),
    'believable',
    'twelve seconds of silence at a three-second cadence must not demote a handset',
  );
  assert.equal(verdict({ gapMs: THREE_S, now: T + 60_000 }), 'believable');
  assert.equal(verdict({ gapMs: THREE_S, now: T + MIN_SILENCE - 1 }), 'believable');
  /* And the floor is a floor, not an amnesty: a phone that really has gone
     silent is still caught, just on the honest timescale. */
  assert.equal(
    verdict({ gapMs: THREE_S, now: T + MIN_SILENCE }),
    'stalled',
    'a tracker silent for the whole floor is still disbelieved',
  );
});

test('the multiplier still governs a deliberately coarse cadence', () => {
  /* A team that samples every five minutes gets the twenty-minute window it
     always had — the floor is under it, not over it, so this did not change. */
  assert.equal(verdict({ now: T + 19 * 60_000 }), 'believable');
  assert.equal(verdict({ now: T + 20 * 60_000 }), 'stalled');
});

test('a task that was never started is not a task to disbelieve', () => {
  /* `start()` answers this one. The watchdog only ever judges a task the OS
     has already accepted — there is nothing to fall back FROM otherwise. */
  assert.equal(verdict({ startedAt: 0 }), 'believable');
  assert.equal(verdict({ startedAt: Number.NaN }), 'believable');
});

test('silence is given the whole window before it means anything', () => {
  /* THE VIVO, at every stage of its morning. Nothing has ever been kept, so the
     window runs from the moment the OS said yes. */
  assert.equal(verdict({ now: T + FIVE_MIN }), 'believable');
  assert.equal(verdict({ now: T + MISSES * FIVE_MIN - 1 }), 'believable');
  /* `>=`, like the cadence beside it: at exactly four missed fixes the fourth
     one is already late, and rounding it away buys a fifth for nothing. */
  assert.equal(verdict({ now: T + MISSES * FIVE_MIN }), 'stalled');
});

test('a fix kept since the start resets the window', () => {
  /* The task is delivering, slowly. Measured from the START alone this would
     read as stalled after twenty minutes however many fixes had arrived. */
  const kept = T + 18 * 60_000;
  assert.equal(verdict({ now: kept + FIVE_MIN, lastKeptAt: kept }), 'believable');
  assert.equal(verdict({ now: kept + MISSES * FIVE_MIN, lastKeptAt: kept }), 'stalled');
});

test("yesterday's mark does not condemn this morning's task", () => {
  /* `LAST_KEPT` is persisted and outlives the day. Measured from it alone, a
     task started at eight this morning would be stalled before it had been
     given a single delivery. */
  assert.equal(
    verdict({ now: T + 60_000, startedAt: T, lastKeptAt: T - 20 * 60 * 60_000 }),
    'believable',
  );
});

test('a clock corrected BACKWARDS restarts the window rather than wedging it', () => {
  /* The start mark is in a future this phone no longer believes in. Read as
     elapsed time it is negative, which would make the watchdog believable for
     ever; read as "long ago" it would demote a task that had just started. */
  assert.equal(verdict({ now: T, startedAt: T + 3_600_000 }), 'restart-the-clock');
});

test('a kept mark in the future is discarded rather than trusted', () => {
  /* The dangerous direction is not noticing. A future `lastKeptAt` on a task
     that IS delivering is corrected by the next fix `shouldKeepFix` lets
     through — within one cadence — so ignoring it costs at most one needless
     fall back to the floor. Trusting it would hold the watchdog shut for the
     whole size of the correction, which is exactly the dead trail this rule
     exists to catch. */
  assert.equal(
    verdict({ now: T + MISSES * FIVE_MIN, lastKeptAt: T + 10 * 3_600_000 }),
    'stalled',
  );
});

test('how many cadences is configuration, not a number in the rule', () => {
  assert.equal(verdict({ now: T + 3 * FIVE_MIN, silentCadences: 2 }), 'stalled');
  assert.equal(verdict({ now: T + 3 * FIVE_MIN, silentCadences: 10 }), 'believable');
  /* And so is the cadence itself: the window is a multiple of the gap between
     KEPT fixes, because `lastKeptAt` is the only mark there is to read. */
  assert.equal(verdict({ now: T + 3 * FIVE_MIN, gapMs: 60_000 }), 'stalled');
});

test('a nonsensical setting is floored rather than collapsing the window', () => {
  /* Zero would make the window zero, and a window of zero is silence of no
     milliseconds at all: every handset in the field off the background task on
     its first tick, for nothing. It falls back to one cadence instead. */
  assert.equal(verdict({ now: T + FIVE_MIN - 1, silentCadences: 0 }), 'believable');
  assert.equal(verdict({ now: T + FIVE_MIN, silentCadences: 0 }), 'stalled');
});
