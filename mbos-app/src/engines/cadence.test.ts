import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldKeepFix } from './cadence';

/**
 * The cadence, pinned.
 *
 * This is the rule that ran wrong in production for three days at a hundred
 * times the intended rate, on two settings that both looked like they were
 * enforcing it and neither of which was. It is a handful of lines and it is
 * worth every one of these assertions: the failure was invisible — the uploads
 * succeeded, the connection was fine, and the only symptom was a Live map
 * showing last night.
 */

const FIVE_MIN = 5 * 60_000;
const T = 1_700_000_000_000;

test('the first fix of a day is always kept', () => {
  /* Nothing kept yet. It is the fix that says he set off, and a cadence that
     made him wait five minutes for it would lose the departure. */
  assert.equal(shouldKeepFix({ at: T, lastKeptAt: 0, gapMs: FIVE_MIN }), true);
});

test('a fix inside the gap is dropped, and one on the boundary is kept', () => {
  assert.equal(shouldKeepFix({ at: T + 3_000, lastKeptAt: T, gapMs: FIVE_MIN }), false);
  assert.equal(shouldKeepFix({ at: T + FIVE_MIN - 1, lastKeptAt: T, gapMs: FIVE_MIN }), false);
  /* `>=`, not `>`. At exactly the gap the fix is due, and rounding it away
     would make every interval one delivery longer than asked for. */
  assert.equal(shouldKeepFix({ at: T + FIVE_MIN, lastKeptAt: T, gapMs: FIVE_MIN }), true);
});

test('THE THREE-SECOND DELIVERY, which is what actually happened', () => {
  /* Android ignored `timeInterval` and fell back to Accuracy's own 3000 ms, so
     this is the real shape of the batch that arrived. All but the first of
     each five minutes has to be dropped. */
  let lastKeptAt = 0;
  let kept = 0;
  for (let i = 0; i < 200; i += 1) {
    const at = T + i * 3_000;
    if (shouldKeepFix({ at, lastKeptAt, gapMs: FIVE_MIN })) {
      kept += 1;
      lastKeptAt = at;
    }
  }
  /* 200 deliveries at 3 s span 0 to 597 s — just under ten minutes. The first
     fix, and the one at the five-minute mark. TWO rows instead of two hundred,
     which is the whole of the bug in one number. */
  assert.equal(kept, 2);
});

test('a clock corrected BACKWARDS resets rather than stalling the day', () => {
  /* The mark is in a future this phone no longer believes in. Treating that as
     "too soon" would take no fixes at all until the clock caught up — on a
     handset corrected by an hour, an hour of somebody's day missing with
     nothing anywhere saying why. */
  assert.equal(shouldKeepFix({ at: T, lastKeptAt: T + 3_600_000, gapMs: FIVE_MIN }), true);
});

test('a corrupt mark is not allowed to stop the trail', () => {
  /* `Number(raw)` on anything unparseable is NaN, and every comparison against
     NaN is false — so a `< gap` test would have said "keep" and a `>= gap`
     test would have said "drop for ever". It is stated rather than left to
     the arithmetic. */
  assert.equal(shouldKeepFix({ at: T, lastKeptAt: Number.NaN, gapMs: FIVE_MIN }), true);
});

test('the gap is whatever configuration says, not a number in the rule', () => {
  const oneMin = 60_000;
  assert.equal(shouldKeepFix({ at: T + 90_000, lastKeptAt: T, gapMs: oneMin }), true);
  assert.equal(shouldKeepFix({ at: T + 90_000, lastKeptAt: T, gapMs: FIVE_MIN }), false);
});
