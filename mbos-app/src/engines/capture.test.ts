import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  openSessionStart,
  trackingSecondsLeft,
  agoOrNull,
  chooseCapture,
  countOrNull,
  trackingDeadlineSeconds,
  type CaptureInputs,
} from './capture';

const healthy: CaptureInputs = {
  trackingOn: true,
  serviceAvailable: true,
  serviceStarted: true,
  foregroundGranted: true,
  backgroundGranted: true,
  taskStarted: true,
};

test('our own service wins wherever it started', () => {
  assert.equal(chooseCapture(healthy), 'service');
});

test('the office switch beats everything, including a running service', () => {
  assert.equal(chooseCapture({ ...healthy, trackingOn: false }), 'off');
});

test('no ordinary location permission records nothing at all', () => {
  assert.equal(chooseCapture({ ...healthy, foregroundGranted: false }), 'off');
});

test('a build without the native module falls back to the expo task', () => {
  assert.equal(
    chooseCapture({ ...healthy, serviceAvailable: false, serviceStarted: false }),
    'task',
  );
});

test('a service the platform refused falls back rather than recording nothing', () => {
  assert.equal(chooseCapture({ ...healthy, serviceStarted: false }), 'task');
});

test('without "always" the task is not offered, even where it would start', () => {
  assert.equal(
    chooseCapture({ ...healthy, serviceStarted: false, backgroundGranted: false }),
    'floor',
  );
});

test('the floor is what is left, never nothing', () => {
  assert.equal(
    chooseCapture({
      ...healthy,
      serviceAvailable: false,
      serviceStarted: false,
      taskStarted: false,
    }),
    'floor',
  );
});

test('the deadline is hours in and seconds out', () => {
  assert.equal(trackingDeadlineSeconds(16), 16 * 3600);
});

test('a nonsense deadline is an hour and never for ever', () => {
  assert.equal(trackingDeadlineSeconds(0), 3600);
  assert.equal(trackingDeadlineSeconds(-4), 3600);
  assert.equal(trackingDeadlineSeconds(Number.NaN), 3600);
});

test('"nothing to say" crosses as null, and is never clamped to now', () => {
  assert.equal(agoOrNull(-1), null);
  assert.equal(agoOrNull(0), 0);
  assert.equal(agoOrNull(41.6), 42);
});

test('a count nobody could produce is null and never zero', () => {
  assert.equal(countOrNull(-1), null);
  assert.equal(countOrNull(0), 0);
  assert.equal(countOrNull(7), 7);
});

test('the deadline is measured from the punch-in, so touching it cannot extend it', () => {
  const openedAt = 1_000_000;
  const hour = 3_600_000;
  assert.equal(trackingSecondsLeft({ openedAt, hours: 16, now: openedAt }), 16 * 3600);
  /* Ten hours later the same call says six, however often it has been asked. */
  assert.equal(trackingSecondsLeft({ openedAt, hours: 16, now: openedAt + 10 * hour }), 6 * 3600);
  /* Past the ceiling it says stop. */
  assert.equal(trackingSecondsLeft({ openedAt, hours: 16, now: openedAt + 17 * hour }), 0);
});

test('nothing open means no tracking at all', () => {
  assert.equal(trackingSecondsLeft({ openedAt: null, hours: 16, now: 5 }), 0);
});

test('a clock corrected backwards keeps the whole ceiling rather than going negative', () => {
  assert.equal(trackingSecondsLeft({ openedAt: 10_000_000, hours: 2, now: 0 }), 7200);
});

test('a session left open past midnight is found on yesterday\'s row', () => {
  const rows = [
    { sessions: JSON.stringify([{ inAt: 5, outAt: 6 }, { inAt: 7, outAt: null }]), checkInAt: 5, checkOutAt: null },
  ];
  assert.equal(openSessionStart(rows), 7);
});

test('a day closed this morning does not fall through to one forgotten open last night', () => {
  const rows = [
    { sessions: JSON.stringify([{ inAt: 10, outAt: 20 }]), checkInAt: 10, checkOutAt: 20 },
    { sessions: JSON.stringify([{ inAt: 1, outAt: null }]), checkInAt: 1, checkOutAt: null },
  ];
  assert.equal(openSessionStart(rows), null);
});

test('a closed day, an unreadable list and no rows all mean nothing is open', () => {
  assert.equal(openSessionStart([{ sessions: JSON.stringify([{ inAt: 1, outAt: 2 }]), checkInAt: 1, checkOutAt: 2 }]), null);
  assert.equal(openSessionStart([{ sessions: '{nope', checkInAt: 1, checkOutAt: null }]), null);
  assert.equal(openSessionStart([]), null);
});

test('a row written before sessions existed is read from its two marks', () => {
  assert.equal(openSessionStart([{ sessions: null, checkInAt: 42, checkOutAt: null }]), 42);
  assert.equal(openSessionStart([{ sessions: null, checkInAt: 42, checkOutAt: 50 }]), null);
});
