import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDecimal, cleanWhole, parseDecimal, parseWhole, typedFromDecimal, wholeOnly } from './decimal-input';

test('a decimal is kept, not joined into a bigger number', () => {
  assert.equal(cleanDecimal('30.5', 2), '30.5');
  assert.equal(parseDecimal('30.5'), 30.5);
  assert.equal(parseDecimal('1.25'), 1.25);
});

test('places are capped as typed', () => {
  assert.equal(cleanDecimal('41208.65', 1), '41208.6');
  assert.equal(cleanDecimal('12.345', 2), '12.34');
});

test('slips are cleaned rather than refused', () => {
  assert.equal(cleanDecimal('1.2.3', 2), '1.23');
  assert.equal(cleanDecimal('1,200.5', 2), '1200.5');
  assert.equal(cleanDecimal('200 L', 2), '200');
  assert.equal(parseDecimal(''), null);
  assert.equal(parseDecimal('.'), null);
  assert.equal(parseDecimal('30.'), 30);
  assert.equal(parseDecimal('.5'), 0.5);
});

test('a stored figure comes back with its fraction', () => {
  assert.equal(typedFromDecimal(30.5, 2), '30.5');
  assert.equal(typedFromDecimal(200, 2), '200');
  assert.equal(typedFromDecimal(0.1 + 0.2, 2), '0.3');
  assert.equal(typedFromDecimal(null, 2), '');
});

test('typing 1.5 into a whole-number box never becomes 15', () => {
  let box = '';
  for (const key of ['1', '.', '5']) box = cleanWhole(box + key);
  assert.equal(box, '1.');
  assert.equal(parseWhole(box), 1);
  assert.equal(wholeOnly(box), true);
  assert.equal(cleanWhole('1.5'), '1.');
});

test('whole numbers stay whole', () => {
  assert.equal(cleanWhole('40'), '40');
  assert.equal(parseWhole('40'), 40);
  assert.equal(parseWhole(''), null);
  assert.equal(parseWhole('.'), null);
  assert.equal(wholeOnly('40'), false);
});
