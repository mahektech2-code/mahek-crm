import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshVerdict, syncSummary, type RefreshSync } from './refresh';

const quiet: RefreshSync = { ran: true, pushed: 0, accepted: 0, rejected: 0, pulled: 0 };
const apk = { kind: 'available' as const, version: '1.14.0', url: 'https://one.mahekindia.com/downloads/mbos.apk' };

test('a newer APK outranks a downloaded bundle', () => {
  const v = refreshVerdict({ sync: quiet, ota: 'ready', apk });
  assert.deepEqual(v.offer, { kind: 'install', version: '1.14.0', url: apk.url });
});

test('a downloaded bundle asks for a restart', () => {
  assert.deepEqual(refreshVerdict({ sync: quiet, ota: 'ready', apk: { kind: 'current' } }).offer, { kind: 'restart' });
});

test('nothing new is just the sync summary', () => {
  for (const ota of ['none', 'off', 'failed'] as const) {
    const v = refreshVerdict({ sync: quiet, ota, apk: { kind: 'current' } });
    assert.deepEqual(v, { offer: null, summary: 'Up to date with the office' });
  }
});

test('an update is still offered when the sync could not run', () => {
  const v = refreshVerdict({
    sync: { ...quiet, ran: false, reason: 'No signal. Everything waits to send.' },
    ota: 'ready',
    apk: { kind: 'current' },
  });
  assert.deepEqual(v.offer, { kind: 'restart' });
  assert.equal(v.summary, 'No signal. Everything waits to send.');
});

test('the summary says what the sync did', () => {
  assert.equal(syncSummary({ ...quiet, pushed: 3, accepted: 3 }), '3 entries sent, and the latest from the office is on your phone');
  assert.equal(syncSummary({ ...quiet, pushed: 1, accepted: 1 }), '1 entry sent, and the latest from the office is on your phone');
  assert.equal(syncSummary({ ...quiet, pushed: 2, rejected: 1, accepted: 1 }), '1 entry was not accepted by the office');
  assert.equal(syncSummary({ ...quiet, ran: false }), 'Could not refresh now. Try again in a minute.');
});
