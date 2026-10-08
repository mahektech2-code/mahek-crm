import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answeredDetails, detailsSummary, fillTouchesDetails, SHOP_DETAIL_FIELDS } from './lead-form';

test('an empty form has nothing behind the tap', () => {
  assert.equal(answeredDetails({}), 0);
  assert.equal(detailsSummary(0), 'Optional. Tap to add what you saw.');
});

test('blank and whitespace answers are not answers', () => {
  assert.equal(answeredDetails({ gstin: '', litres: '   ', competitor: null }), 0);
});

test('a closed section says how many answers it is holding', () => {
  const n = answeredDetails({ litres: '200', competitor: 'Asian Paints', shopPhotoId: 'med_1' });
  assert.equal(n, 3);
  assert.equal(detailsSummary(n), '3 more answered — show');
});

test('a fill that lands behind the tap opens the section, and one that does not leaves it', () => {
  assert.equal(fillTouchesDetails({ custType: 'contractor' }), true);
  assert.equal(fillTouchesDetails({}), false);
});

test('every field the disclosure counts is a distinct name', () => {
  assert.equal(new Set(SHOP_DETAIL_FIELDS).size, SHOP_DETAIL_FIELDS.length);
});
