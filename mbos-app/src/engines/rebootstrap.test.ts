import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REBOOTSTRAP_RETRY_MS, needsRebootstrap } from './rebootstrap';

const NOW = 1_800_000_000_000;

test('the build that took the snapshot does not take it again', () => {
  assert.equal(needsRebootstrap({ bootstrappedBuild: '1.17.0 (24) · embedded', currentBuild: '1.17.0 (24) · embedded', lastFailedAt: null, now: NOW }), false);
});

test('an upgraded APK takes the whole book once', () => {
  assert.equal(needsRebootstrap({ bootstrappedBuild: '1.16.1 (23) · embedded', currentBuild: '1.17.0 (24) · embedded', lastFailedAt: null, now: NOW }), true);
});

test('an over-the-air bundle counts as a new build too', () => {
  assert.equal(needsRebootstrap({ bootstrappedBuild: '1.17.0 (24) · embedded', currentBuild: '1.17.0 (24) · 3f9a1c2b', lastFailedAt: null, now: NOW }), true);
});

test('an install signed in before this rule existed has no record, and refreshes', () => {
  assert.equal(needsRebootstrap({ bootstrappedBuild: null, currentBuild: '1.17.0 (24) · embedded', lastFailedAt: null, now: NOW }), true);
});

test('a failed snapshot waits before it is asked for again', () => {
  const base = { bootstrappedBuild: null, currentBuild: 'x', now: NOW };
  assert.equal(needsRebootstrap({ ...base, lastFailedAt: NOW - 60_000 }), false);
  assert.equal(needsRebootstrap({ ...base, lastFailedAt: NOW - REBOOTSTRAP_RETRY_MS }), true);
  /* A clock moved backwards past the failure must not wait for ever. */
  assert.equal(needsRebootstrap({ ...base, lastFailedAt: NOW + 3_600_000 }), true);
});
