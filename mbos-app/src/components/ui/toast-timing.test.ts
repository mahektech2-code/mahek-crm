import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DWELL_MAX_MS, DWELL_REFUSAL_MIN_MS, DWELL_SHORT_MS, makeFeltOnce, toastDwellMs } from './toast-timing';

test('a short confirmation keeps the old three seconds', () => {
  assert.equal(toastDwellMs('success', 'Saved'), DWELL_SHORT_MS);
  assert.equal(toastDwellMs('info', 'No signal'), DWELL_SHORT_MS);
});

test('a refusal stays up at least six seconds', () => {
  assert.equal(toastDwellMs('error', 'No.'), DWELL_REFUSAL_MIN_MS);
  assert.equal(toastDwellMs('warn', 'Check this'), DWELL_REFUSAL_MIN_MS);
});

test('a long refusal gets reading time, up to a ceiling', () => {
  const sentence =
    'Sai Paints is billed to Om Traders, who is not in your list. Ask the office to move the account, or bill the shop direct.';
  const d = toastDwellMs('error', sentence);
  assert.ok(d > DWELL_REFUSAL_MIN_MS, `expected more than ${DWELL_REFUSAL_MIN_MS}, got ${d}`);
  assert.ok(d <= DWELL_MAX_MS);
  assert.equal(toastDwellMs('error', 'x'.repeat(5000)), DWELL_MAX_MS);
});

test('the same notice redrawn by another window is felt once', () => {
  const felt = makeFeltOnce(2000);
  assert.equal(felt('Saved', 1000), true);
  assert.equal(felt('Saved', 1500), false);
  assert.equal(felt('Saved', 4000), true);
  assert.equal(felt('Other', 4100), true);
});
