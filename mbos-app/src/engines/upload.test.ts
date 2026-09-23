import { test } from 'node:test';
import assert from 'node:assert/strict';

import { backoffDelayMs, chooseSender } from './upload';

/**
 * The two rules the native uploader runs on, pinned.
 *
 * Neither of them can be exercised where it actually runs — one is read by a
 * file that imports expo-location at module scope, the other is mirrored into
 * Kotlin inside a foreground service — so this is the only place either is
 * ever executed before it reaches a phone that cannot be recalled.
 */

const SIX = 6_000;
const CEILING = 5 * 60_000;
const SETTLE_CEILING = 60_000;

/* ------------------------------------------------------------------- owner */

test('the recorder owns sending whenever it says it is sending', () => {
  assert.equal(chooseSender({ serviceAvailable: true, nativeUploads: true }), 'native');
});

test('the app takes the queue back where the recorder is not sending', () => {
  assert.equal(chooseSender({ serviceAvailable: true, nativeUploads: false }), 'js');
});

test('a build with no recorder in it is the app, exactly as it always was', () => {
  assert.equal(chooseSender({ serviceAvailable: false, nativeUploads: true }), 'js');
  assert.equal(chooseSender({ serviceAvailable: false, nativeUploads: false }), 'js');
});

/* A recorder that BELIEVES it is sending and is not. See `chooseSender`. */

test('a wedged recorder loses the queue, however firmly it says it is sending', () => {
  /* Four in the afternoon until eleven at night, on a handset in constant
     contact with the office. Every other reading on this phone was healthy. */
  assert.equal(
    chooseSender({
      serviceAvailable: true,
      nativeUploads: true,
      lastUploadAgoSeconds: 7 * 3_600,
      buffered: 4_200,
    }),
    'js',
  );
});

test('a recorder holding fixes it has NEVER got accepted is the worst case, not the innocent one', () => {
  assert.equal(
    chooseSender({
      serviceAvailable: true,
      nativeUploads: true,
      lastUploadAgoSeconds: null,
      buffered: 300,
    }),
    'js',
  );
});

test('an empty buffer is never an accusation, however long the silence', () => {
  /* A recorder that has sent nothing because it had nothing to send is every
     phone on a quiet afternoon. Reading an absence as a fault is the one
     thing this file is written against. */
  assert.equal(
    chooseSender({
      serviceAvailable: true,
      nativeUploads: true,
      lastUploadAgoSeconds: 9 * 3_600,
      buffered: 0,
    }),
    'native',
  );
});

test('a buffer this build cannot report leaves the recorder alone', () => {
  /* Null is not zero and it is not "something is stuck" either. */
  assert.equal(
    chooseSender({
      serviceAvailable: true,
      nativeUploads: true,
      lastUploadAgoSeconds: 9 * 3_600,
      buffered: null,
    }),
    'native',
  );
});

test('an ordinary bad patch of signal is not a wedge', () => {
  /* The recorder's own retry curve tops out at five minutes, so a few
     ceiling-length waits is it working. Handing the queue back and forth
     across those would be two owners and no draining. */
  assert.equal(
    chooseSender({
      serviceAvailable: true,
      nativeUploads: true,
      lastUploadAgoSeconds: 14 * 60,
      buffered: 800,
    }),
    'native',
  );
  assert.equal(
    chooseSender({
      serviceAvailable: true,
      nativeUploads: true,
      lastUploadAgoSeconds: 16 * 60,
      buffered: 800,
    }),
    'js',
  );
});

test('a caller that says nothing about either reading behaves exactly as before', () => {
  /* An APK cannot be recalled and neither can a caller that has not been
     updated: an answer nobody passed is an answer nobody has. */
  assert.equal(chooseSender({ serviceAvailable: true, nativeUploads: true }), 'native');
});

/* ----------------------------------------------------------------- backoff */

test('a successful send waits exactly the configured cadence', () => {
  assert.equal(
    backoffDelayMs({ cadenceMs: SIX, consecutiveFailures: 0, outcome: 'sent' }),
    SIX,
  );
});

test('an empty buffer is not a failure and does not slow the cadence', () => {
  assert.equal(
    backoffDelayMs({ cadenceMs: SIX, consecutiveFailures: 9, outcome: 'nothing-to-send' }),
    SIX,
  );
});

test('failures double, and the first one is already a wait rather than a retry storm', () => {
  assert.equal(
    backoffDelayMs({ cadenceMs: SIX, consecutiveFailures: 1, outcome: 'failed' }),
    12_000,
  );
  assert.equal(
    backoffDelayMs({ cadenceMs: SIX, consecutiveFailures: 3, outcome: 'failed' }),
    48_000,
  );
});

test('the doubling stops at the ceiling and never runs away', () => {
  assert.equal(
    backoffDelayMs({ cadenceMs: SIX, consecutiveFailures: 40, outcome: 'failed' }),
    CEILING,
  );
  /* The overflow guard as well as the clamp: 2 ** 40 of six seconds is a
     number, 2 ** 4000 is Infinity, and Math.min against Infinity is the
     ceiling either way — but only if the exponent is bounded first. */
  assert.ok(Number.isFinite(
    backoffDelayMs({ cadenceMs: SIX, consecutiveFailures: 4_000, outcome: 'failed' }),
  ));
});

test('no network goes straight to the ceiling rather than walking up to it', () => {
  assert.equal(
    backoffDelayMs({ cadenceMs: SIX, consecutiveFailures: 0, outcome: 'offline' }),
    CEILING,
  );
});

test('no usable credential waits the same way, because waiting changes nothing', () => {
  assert.equal(
    backoffDelayMs({ cadenceMs: SIX, consecutiveFailures: 0, outcome: 'blocked' }),
    CEILING,
  );
});

test('waiting for a check-in to land has its own, shorter ceiling', () => {
  assert.equal(
    backoffDelayMs({ cadenceMs: SIX, consecutiveFailures: 40, outcome: 'not-yet-fileable' }),
    SETTLE_CEILING,
  );
  /* And it still climbs underneath it, so a check-in that never comes is not
     asked about every six seconds for a week. */
  assert.equal(
    backoffDelayMs({ cadenceMs: SIX, consecutiveFailures: 2, outcome: 'not-yet-fileable' }),
    24_000,
  );
});

test('a nonsense cadence cannot produce a zero delay, which would be a spin', () => {
  for (const cadenceMs of [0, -6_000, Number.NaN, Number.POSITIVE_INFINITY]) {
    const delay = backoffDelayMs({ cadenceMs, consecutiveFailures: 0, outcome: 'sent' });
    assert.ok(delay > 0 && Number.isFinite(delay), `cadence ${cadenceMs} gave ${delay}`);
  }
});
