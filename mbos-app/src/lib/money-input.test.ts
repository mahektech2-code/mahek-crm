import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanAmount, paiseFromTyped, typedFromPaise } from './money-input';

test('a bill with paise is collected exactly, not rounded to the rupee', () => {
  assert.equal(typedFromPaise(1_045_060), '10450.60');
  assert.equal(paiseFromTyped(typedFromPaise(1_045_060)), 1_045_060);
  assert.equal(typedFromPaise(1_045_040), '10450.40');
  assert.equal(paiseFromTyped('10450.40'), 1_045_040);
});

test('whole rupees stay bare', () => {
  assert.equal(typedFromPaise(4_250_000), '42500');
  assert.equal(paiseFromTyped('42500'), 4_250_000);
});

test('a single decimal digit is tenths, not paise', () => {
  assert.equal(paiseFromTyped('12.5'), 1250);
});

test('slips are cleaned rather than refused', () => {
  assert.equal(cleanAmount('1,200.505'), '1200.50');
  assert.equal(cleanAmount('1.2.3'), '1.23');
  assert.equal(paiseFromTyped(''), 0);
  assert.equal(paiseFromTyped('.'), 0);
  assert.equal(typedFromPaise(0), '');
});
