import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_MODES, fieldModes } from './payment-modes';

test("the office's list is offered, minus the two that are not money arriving", () => {
  assert.deepEqual(
    fieldModes(['Bank transfer', 'UPI', 'Cheque', 'Cash', 'Adjustment', 'Credit note']),
    ['Bank transfer', 'UPI', 'Cheque', 'Cash'],
  );
});

test('a mode accounts added reaches the form', () => {
  assert.deepEqual(fieldModes(['Cash', 'Demand draft']), ['Cash', 'Demand draft']);
});

test('the desk-only modes are recognised whatever their case', () => {
  assert.deepEqual(fieldModes(['Cash', 'credit NOTE', ' adjustment ']), ['Cash']);
});

test('an older server that sends nothing gets the four the form always had', () => {
  assert.deepEqual(fieldModes(undefined), [...FALLBACK_MODES]);
  assert.deepEqual(fieldModes('Cash'), [...FALLBACK_MODES]);
  assert.deepEqual(fieldModes(['Adjustment']), [...FALLBACK_MODES]);
});
