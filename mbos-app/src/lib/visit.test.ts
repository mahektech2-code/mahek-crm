import test from 'node:test';
import assert from 'node:assert/strict';

import {
  arrivalIsCurrent,
  outcomeNeedsNote,
  unansweredQuestions,
  visitChecks,
  visitVerdict,
  withCheckIn,
} from './visit';

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

/* ══════════════════════════════════ checking out: the answers are owed */

const facts = {
  gpsLocked: true,
  metresAway: 20,
  dwellSeconds: 600,
  minimumDwellSeconds: 120,
  maxMetresFromShop: 100,
  checkInOverridden: false,
  hasShopPhoto: true,
  outcome: 'visited' as const,
  followOnCaptured: false,
  noteChars: 60,
  minimumNoteChars: 20,
};

test('a visit where somebody was spoken to cannot be checked out of with nothing written', () => {
  const checks = visitChecks({ ...facts, noteChars: 0 });
  assert.equal(visitVerdict(checks).complete, false);
  assert.deepEqual(
    unansweredQuestions(checks).map((c) => c.key),
    ['note'],
    'the note is asked for, by name',
  );
});

test('a few characters are not an account of the visit', () => {
  const checks = visitChecks({ ...facts, noteChars: 5 });
  const note = checks.find((c) => c.key === 'note')!;
  assert.equal(note.ok, false);
  assert.match(note.line, /15 more characters/);
});

test('a shop found shut needs no note — there is nothing to report but the shutter', () => {
  assert.equal(outcomeNeedsNote('closed'), false);
  const checks = visitChecks({ ...facts, outcome: 'closed', noteChars: 0 });
  assert.equal(checks.find((c) => c.key === 'note')!.ok, true);
  assert.equal(visitVerdict(checks).complete, true);
});

test('no outcome chosen is asked first, and the note with it', () => {
  const checks = visitChecks({ ...facts, outcome: null, noteChars: 0 });
  assert.deepEqual(unansweredQuestions(checks).map((c) => c.key), ['outcome', 'note']);
});

test('the evidence is not an answer — missing GPS or photo owes no question', () => {
  /* Those are waived by an unverified save; the answers never are. */
  const checks = visitChecks({ ...facts, gpsLocked: false, hasShopPhoto: false });
  assert.equal(visitVerdict(checks).complete, false);
  assert.deepEqual(unansweredQuestions(checks), []);
});

test('an order outcome owes the order AND the note', () => {
  const checks = visitChecks({ ...facts, outcome: 'order', followOnCaptured: false, noteChars: 0 });
  assert.deepEqual(unansweredQuestions(checks).map((c) => c.key), ['followon', 'note']);
});
