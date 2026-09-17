import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mayRestartTracker,
  recordRestart,
  restartsToday,
  rollOver,
  NO_RESTARTS,
  type RestartRecord,
} from './tracker-restart';

/**
 * The restart rule, pinned.
 *
 * What this replaces is a module-level boolean that was set once and cleared
 * by nothing, so the FIRST demotion of a process was its last word on the
 * subject — and the thing it demoted to only advanced while the app was on
 * screen. There was no test because there was nothing testable: the decision
 * lived inside a file that imports expo-location at module scope. Every
 * assertion below is a sentence somebody would otherwise have had to prove on
 * a handset in Nagpur.
 */

const MIN = 60_000;
const T = 1_800_000_000_000;
const TODAY = '2026-09-18';
const YESTERDAY = '2026-09-17';

const base = { now: T, today: TODAY, minIntervalMs: 15 * MIN, maxPerDay: 12 };

test('a handset that has never restarted may restart', () => {
  assert.equal(mayRestartTracker({ ...base, record: NO_RESTARTS }), true);
});

test('a second attempt waits out the interval, and the boundary counts', () => {
  const record: RestartRecord = { at: T, day: TODAY, attempts: 1 };
  assert.equal(mayRestartTracker({ ...base, record, now: T + 14 * MIN }), false);
  /* `>=`, not `>`. At exactly the interval the attempt is due; rounding it
     away would make every gap one watchdog tick longer than the office asked
     for, which on a dead trail is more minutes of somebody's route. */
  assert.equal(mayRestartTracker({ ...base, record, now: T + 15 * MIN }), true);
});

test('yesterday is a clean slate, whatever it spent', () => {
  /* Overnight is when a phone is charged and when an OEM battery manager's
     own bookkeeping resets. A ceiling reached yesterday must not greet a
     salesman as a tracker that has already given up this morning. */
  const spent: RestartRecord = { at: T - 20 * MIN, day: YESTERDAY, attempts: 99 };
  assert.equal(mayRestartTracker({ ...base, record: spent }), true);
  assert.equal(restartsToday(spent, TODAY), 0);
});

test('the daily ceiling stops the asking, and outranks the interval', () => {
  const spent: RestartRecord = { at: T - 3 * 60 * MIN, day: TODAY, attempts: 12 };
  /* Long past the interval, so only the ceiling can be refusing it. */
  assert.equal(mayRestartTracker({ ...base, record: spent }), false);
  assert.equal(mayRestartTracker({ ...base, record: { ...spent, attempts: 11 } }), true);
});

test('a ceiling of zero means no ceiling, never "never restart"', () => {
  /*
   * A setting that silently switched off the only mechanism that brings a dead
   * trail back would be the most expensive possible way for somebody to say "I
   * was not sure what to put here" — and nothing on any screen would report a
   * handset that had quietly stopped trying.
   */
  const spent: RestartRecord = { at: T - 60 * MIN, day: TODAY, attempts: 500 };
  assert.equal(mayRestartTracker({ ...base, record: spent, maxPerDay: 0 }), true);
});

test('a mark in the future retries rather than waiting for a future it no longer believes in', () => {
  const ahead: RestartRecord = { at: T + 60 * MIN, day: TODAY, attempts: 1 };
  assert.equal(mayRestartTracker({ ...base, record: ahead }), true);
});

test('a corrupt record is read as nothing tried, not as a refusal', () => {
  const junk = { at: Number.NaN, day: TODAY, attempts: Number.NaN } as RestartRecord;
  assert.deepEqual(rollOver(junk, TODAY), { at: 0, day: TODAY, attempts: 0 });
  assert.equal(mayRestartTracker({ ...base, record: junk }), true);
});

test('an attempt is counted when it is made, not when it works', () => {
  /* `startLocationUpdatesAsync` answering yes is precisely the thing this
     subsystem has learned not to believe, so counting outcomes would count
     nothing. The interval bounds how often we ASK. */
  const first = recordRestart(NO_RESTARTS, T, TODAY);
  assert.deepEqual(first, { at: T, day: TODAY, attempts: 1 });
  const second = recordRestart(first, T + 20 * MIN, TODAY);
  assert.deepEqual(second, { at: T + 20 * MIN, day: TODAY, attempts: 2 });
});

test('the first attempt of a new day starts the count again', () => {
  const spent: RestartRecord = { at: T - 20 * MIN, day: YESTERDAY, attempts: 9 };
  assert.deepEqual(recordRestart(spent, T, TODAY), { at: T, day: TODAY, attempts: 1 });
});

test('zero restarts today is an answer, and it is the healthy one', () => {
  assert.equal(restartsToday(NO_RESTARTS, TODAY), 0);
  assert.equal(restartsToday({ at: T, day: TODAY, attempts: 6 }, TODAY), 6);
});
