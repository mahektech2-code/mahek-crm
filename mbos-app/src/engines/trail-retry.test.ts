import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mayRetryBackground, type RetryInput } from './trail-retry';

/**
 * The recovery path, pinned.
 *
 * What this replaces is a boolean that was set once and cleared never, so the
 * assertion that matters most here is the dullest one: that a demotion EXPIRES.
 * A phone demoted at nine in the morning and pocketed recorded nothing for the
 * rest of that day, on every screen looking perfectly healthy, and no test
 * could have caught it because the rule lived in a file that imports
 * expo-location at module scope.
 */

const HALF_HOUR = 30 * 60_000;
/* 2026-09-18 09:00 local-ish. The exact instant does not matter; the day
   string is carried rather than derived, precisely so no test here has to
   reason about a timezone. */
const T = 1_789_700_000_000;

const BASE: RetryInput = {
  demotion: { at: T, day: '2026-09-18' },
  now: T + 60_000,
  today: '2026-09-18',
  freshCheckIn: false,
  retryAfterMs: HALF_HOUR,
};

test('a process that has never demoted always tries the real thing', () => {
  assert.equal(mayRetryBackground({ ...BASE, demotion: null }), true);
});

test('a demotion a minute old stands — this is the objection that produced it', () => {
  /* Retrying on every resume is what would clear the floor's timer and hand a
     dead task another whole silent window. */
  assert.equal(mayRetryBackground(BASE), false);
});

test('a demotion expires once the configured interval has passed', () => {
  assert.equal(mayRetryBackground({ ...BASE, now: T + HALF_HOUR - 1 }), false);
  assert.equal(mayRetryBackground({ ...BASE, now: T + HALF_HOUR }), true);
});

test('a check-in re-opens it however recent the demotion', () => {
  assert.equal(mayRetryBackground({ ...BASE, freshCheckIn: true }), true);
});

test('a new calendar day re-opens it, even a minute after midnight', () => {
  assert.equal(
    mayRetryBackground({ ...BASE, today: '2026-09-19', now: T + 60_000 }),
    true,
  );
});

test('a clock corrected backwards retries rather than waiting out a future mark', () => {
  assert.equal(mayRetryBackground({ ...BASE, now: T - 60 * 60_000 }), true);
});

test('a nonsense mark is not evidence', () => {
  assert.equal(mayRetryBackground({ ...BASE, demotion: { at: 0, day: '2026-09-18' } }), true);
  assert.equal(
    mayRetryBackground({ ...BASE, demotion: { at: Number.NaN, day: '2026-09-18' } }),
    true,
  );
});

test('a retry interval of zero is every call, and is allowed to be', () => {
  /* Not a recommendation — a deployment that would rather lose windows than
     lose pocketed time may choose it, and the engine must not quietly refuse
     a number somebody set. */
  assert.equal(mayRetryBackground({ ...BASE, retryAfterMs: 0 }), true);
});
