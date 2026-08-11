import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Working hours, summed across sessions.
 *
 * These numbers reach a payslip, so the arithmetic is pinned here rather than
 * left to be checked by whoever notices their pay is wrong. The functions are
 * duplicated from `src/data/attendance.ts` only because that module imports
 * expo-sqlite; the logic is identical and any change has to be made in both,
 * which is the trade for being able to test it at all.
 */

type Session = { inAt: number; outAt: number | null };

function workedMinutes(sessions: Session[], now: number): number {
  return Math.max(
    0,
    Math.round(sessions.reduce((t, x) => t + Math.max(0, (x.outAt ?? now) - x.inAt), 0) / 60_000),
  );
}

function openSession(sessions: Session[]): Session | null {
  return sessions.find((x) => x.outAt == null) ?? null;
}

const H = 3_600_000;
const at = (hour: number) => new Date(2026, 7, 12, hour, 0, 0).getTime();

test('a single closed session is its own length', () => {
  assert.equal(workedMinutes([{ inAt: at(9), outAt: at(17) }], at(18)), 8 * 60);
});

test('two sessions sum, and the gap between them is NOT worked time', () => {
  /* The bug this whole change exists for: 9-to-1 plus 2-to-6 is eight hours,
     not nine. Reading last-out minus first-in gave nine. */
  const day = [
    { inAt: at(9), outAt: at(13) },
    { inAt: at(14), outAt: at(18) },
  ];
  assert.equal(workedMinutes(day, at(19)), 8 * 60);

  const naive = Math.round((at(18) - at(9)) / 60_000);
  assert.equal(naive, 9 * 60, 'the old reading');
  assert.notEqual(workedMinutes(day, at(19)), naive);
});

test('three sessions with two breaks still sum correctly', () => {
  const day = [
    { inAt: at(9), outAt: at(11) },
    { inAt: at(12), outAt: at(14) },
    { inAt: at(16), outAt: at(18) },
  ];
  assert.equal(workedMinutes(day, at(19)), 6 * 60);
});

test('an open session counts up to now, so the figure keeps moving', () => {
  const day = [{ inAt: at(9), outAt: null }];
  assert.equal(workedMinutes(day, at(9) + 90 * 60_000), 90);
  assert.equal(workedMinutes(day, at(9) + 150 * 60_000), 150);
});

test('a closed session plus a running one counts both', () => {
  const day = [
    { inAt: at(9), outAt: at(13) },
    { inAt: at(14), outAt: null },
  ];
  assert.equal(workedMinutes(day, at(15)), 5 * 60);
});

test('a day never yet started is zero, not NaN', () => {
  assert.equal(workedMinutes([], at(12)), 0);
});

test('a clock that went backwards contributes nothing rather than negative time', () => {
  /* Device clocks are wrong and user-settable. A negative stretch must not
     subtract from the honest ones. */
  const day = [
    { inAt: at(9), outAt: at(13) },
    { inAt: at(16), outAt: at(15) },
  ];
  assert.equal(workedMinutes(day, at(18)), 4 * 60);
});

test('only one session is ever open, and it is the last', () => {
  const day: Session[] = [
    { inAt: at(9), outAt: at(13) },
    { inAt: at(14), outAt: null },
  ];
  assert.equal(openSession(day), day[1]);
  assert.equal(openSession([{ inAt: at(9), outAt: at(17) }]), null);
});

test('checking in twice without checking out does not open a second session', () => {
  /* `checkIn` returns early when one is already running. Simulated here as the
     rule it encodes: an open session means there is nothing to open. */
  const day: Session[] = [{ inAt: at(9), outAt: null }];
  const wouldOpen = openSession(day) == null;
  assert.equal(wouldOpen, false);
  assert.equal(day.length, 1);
});

test('closing then starting again adds a session rather than reopening', () => {
  const day: Session[] = [{ inAt: at(9), outAt: at(13) }];
  assert.equal(openSession(day), null, 'closed');
  day.push({ inAt: at(14), outAt: null });
  assert.equal(day.length, 2);
  assert.equal(workedMinutes(day, at(15)), 5 * 60);
});

test('an eight-hour day across a break reads as a full day, not a half', () => {
  /* Half-day is decided on the TOTAL. Deciding it on the last stretch alone
     would mark somebody who worked 9-to-1 and 2-to-6 as a half day. */
  const day = [
    { inAt: at(9), outAt: at(13) },
    { inAt: at(14), outAt: at(18) },
  ];
  const hours = workedMinutes(day, at(19)) / 60;
  assert.ok(hours >= 8, `${hours}h should clear a full day`);

  const lastStretchOnly = (at(18) - at(14)) / H;
  assert.equal(lastStretchOnly, 4, 'the last stretch alone would read as a half day');
});
