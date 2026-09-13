import test from 'node:test';
import assert from 'node:assert/strict';

import { arrivalIsCurrent, withCheckIn } from './visit';

/**
 * ARRIVING AND CHECKING IN, which are now two acts.
 *
 * Both rules here fail SILENTLY in the field — a stale arrival looks like the
 * app being helpful, and a restarted clock looks like a short visit — so they
 * are pinned where they can be read rather than left to a handset.
 */

const arrival = { arrivedAt: 1_700_000_000_000, checkedInAt: null, day: '2026-09-13' };

test('an arrival from an earlier day is not today’s', () => {
  assert.equal(arrivalIsCurrent(arrival, '2026-09-13'), true);
  assert.equal(arrivalIsCurrent(arrival, '2026-09-14'), false);
});

test('checking in stamps the instant he walked in', () => {
  const after = withCheckIn(arrival, 1_700_000_600_000);
  assert.equal(after.checkedInAt, 1_700_000_600_000);
  /* The arrival is untouched: the journey ended when it ended. */
  assert.equal(after.arrivedAt, arrival.arrivedAt);
});

test('a second tap does NOT restart the clock', () => {
  const first = withCheckIn(arrival, 1_700_000_600_000);
  const second = withCheckIn(first, 1_700_000_900_000);
  assert.equal(
    second.checkedInAt,
    1_700_000_600_000,
    'the first instant stands — a slip must never shorten the visit',
  );
});
