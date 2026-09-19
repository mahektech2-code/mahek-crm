import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
