import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceLabel, shopName } from './format';

/**
 * Every example here is a real customer name off the production book, or the
 * exact shape of one. That matters: the rule is a compromise, and the only
 * useful question about a compromise is what it does to the data it will
 * actually meet.
 */

test('a shouted name is calmed down', () => {
  assert.equal(shopName('MAULI ENTERPRISES'), 'Mauli Enterprises');
  assert.equal(shopName('AHYAN ELECTRIC & HARDWARE'), 'Ahyan Electric & Hardware');
  assert.equal(shopName('WHOLESALE COLOUR COMPANY'), 'Wholesale Colour Company');
});

test('a whispered one is brought up', () => {
  assert.equal(shopName('jaihind hardware store'), 'Jaihind Hardware Store');
  assert.equal(shopName('r k paints house'), 'R K Paints House');
  assert.equal(shopName('shringi color point'), 'Shringi Color Point');
});

test('a half-typed name is finished, without touching what was deliberate', () => {
  assert.equal(shopName('Vinayak sale'), 'Vinayak Sale');
  assert.equal(shopName('new Asha paint'), 'New Asha Paint');
});

test('an acronym somebody shouted on purpose is left alone', () => {
  /* The rule that earns its keep: without it these become Jsk and P. */
  assert.equal(shopName('JSK Hardware'), 'JSK Hardware');
  assert.equal(shopName('P Janardhan Rao'), 'P Janardhan Rao');
  assert.equal(shopName('3D Traders'), '3D Traders');
});

test('and mixed case inside a word is somebody spelling it that way', () => {
  assert.equal(shopName('McDonald Paints'), 'McDonald Paints');
});

test('separators keep their shape', () => {
  /* Splitting on them and rejoining is how M/S becomes M / S. */
  assert.equal(shopName('M/S GUPTA TRADERS'), 'M/S Gupta Traders');
  assert.equal(shopName('r.k. enterprises'), 'R.K. Enterprises');
  assert.equal(shopName('  SHAH   AND  SONS '), 'Shah   And  Sons');
});

test('what it cannot do, stated rather than pretended', () => {
  /* Inside an all-capitals name nothing distinguishes the acronym from the
     rest, so this one is wrong and knowingly so. */
  assert.equal(shopName('JSK HARDWARE'), 'Jsk Hardware');
});

test('nothing in, nothing out', () => {
  assert.equal(shopName(''), '');
  assert.equal(shopName(null), '');
  assert.equal(shopName(undefined), '');
});

test('distance is said the way somebody walking would say it', () => {
  assert.equal(distanceLabel(0), '10 m', 'never claims to be standing on it');
  assert.equal(distanceLabel(83), '80 m', 'rounded to ten — the fix is not better than that');
  assert.equal(distanceLabel(940), '940 m');
  assert.equal(distanceLabel(1200), '1.2 km');
  assert.equal(distanceLabel(9949), '9.9 km');
  assert.equal(distanceLabel(14200), '14 km', 'a tenth of a km means nothing at this range');
});

test('no fix, no figure', () => {
  assert.equal(distanceLabel(null), null);
  assert.equal(distanceLabel(undefined), null);
  assert.equal(distanceLabel(Number.NaN), null);
  assert.equal(distanceLabel(-5), null);
});
