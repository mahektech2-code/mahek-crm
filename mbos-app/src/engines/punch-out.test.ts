import { test } from 'node:test';
import assert from 'node:assert/strict';

import { punchOutDue, workingHour } from './punch-out';

/**
 * The punch-out prompt, pinned. Both directions matter: a prompt that never
 * comes is the bug this exists for, and one that comes at lunch, or to
 * somebody already punched out, is how a prompt stops being read.
 */

/* 2026-10-03 in IST, as UTC instants: IST is UTC+05:30. */
const ist = (h: number, m = 0) => Date.UTC(2026, 9, 3, h, m) - 330 * 60_000;

test('the hour is read in Asia/Kolkata, not the zone of the machine', () => {
  assert.equal(workingHour(ist(9, 15)), 9);
  assert.equal(workingHour(ist(18, 0)), 18);
  assert.equal(workingHour(ist(0, 5)), 0);
  assert.equal(workingHour(ist(23, 59)), 23);
});

test('not due before the prompt hour', () => {
  assert.equal(punchOutDue({ running: true, nowMs: ist(17, 59), promptHour: 18 }), false);
});

test('due from the prompt hour on, while a session is open', () => {
  assert.equal(punchOutDue({ running: true, nowMs: ist(18, 0), promptHour: 18 }), true);
  assert.equal(punchOutDue({ running: true, nowMs: ist(21, 30), promptHour: 18 }), true);
});

test('never due once the day is closed', () => {
  assert.equal(punchOutDue({ running: false, nowMs: ist(20, 0), promptHour: 18 }), false);
});

test('an out-of-range hour is clamped rather than read literally', () => {
  assert.equal(punchOutDue({ running: true, nowMs: ist(23, 0), promptHour: 40 }), true);
  assert.equal(punchOutDue({ running: true, nowMs: ist(0, 0), promptHour: -3 }), true);
});
