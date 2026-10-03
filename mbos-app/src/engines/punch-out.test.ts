import { test } from 'node:test';
import assert from 'node:assert/strict';

import { punchOutDue, punchOutReminderTimes, workingHour } from './punch-out';

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

test('reminders: the prompt hour and the second nudge, both still ahead', () => {
  const at = punchOutReminderTimes({ nowMs: ist(10, 0), promptHour: 18, secondAfterMinutes: 90 });
  assert.deepEqual(at, [{ at: ist(18, 0), nth: 1 }, { at: ist(19, 30), nth: 2 }]);
});

test('reminders: one already passed is not scheduled again', () => {
  const at = punchOutReminderTimes({ nowMs: ist(18, 10), promptHour: 18, secondAfterMinutes: 90 });
  assert.deepEqual(at, [{ at: ist(19, 30), nth: 2 }]);
});

test('reminders: none once both have passed', () => {
  assert.deepEqual(punchOutReminderTimes({ nowMs: ist(20, 0), promptHour: 18, secondAfterMinutes: 90 }), []);
});

test('reminders: zero turns the second one off', () => {
  assert.deepEqual(
    punchOutReminderTimes({ nowMs: ist(9, 0), promptHour: 18, secondAfterMinutes: 0 }),
    [{ at: ist(18, 0), nth: 1 }],
  );
});

test('reminders: never spill past midnight into a day nobody has started', () => {
  assert.deepEqual(
    punchOutReminderTimes({ nowMs: ist(9, 0), promptHour: 23, secondAfterMinutes: 120 }),
    [{ at: ist(23, 0), nth: 1 }],
  );
});

test('reminders: an instant just after IST midnight belongs to the new IST day', () => {
  /* 00:10 IST is 18:40 UTC the previous calendar day — the date must come
     from Asia/Kolkata, not from UTC, or this schedules for yesterday. */
  const at = punchOutReminderTimes({ nowMs: ist(0, 10), promptHour: 18, secondAfterMinutes: 0 });
  assert.deepEqual(at, [{ at: ist(18, 0), nth: 1 }]);
});
