import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leftShopVerdict, type LeftShopFacts } from './left-shop';

/** Nagpur, Sadar. */
const SHOP = { lat: 21.1601, lng: 79.0805 };
const northOf = (m: number) => ({ lat: SHOP.lat + m / 111_320, lng: SHOP.lng });

const base = (over: Partial<LeftShopFacts> = {}): LeftShopFacts => ({
  checkedInAt: 1_000,
  alreadyAsked: false,
  anchor: SHOP,
  fix: { ...northOf(700), accuracyM: 20, at: 2_000 },
  thresholdM: 500,
  ...over,
});

test('700 m from where he checked in, on a good reading, he has left', () => {
  const v = leftShopVerdict(base());
  assert.equal(v.left, true);
  assert.ok(v.left && v.metres > 690 && v.metres < 710);
});

test('still inside the threshold is not leaving', () => {
  assert.equal(leftShopVerdict(base({ fix: { ...northOf(300), accuracyM: 10, at: 2_000 } })).left, false);
});

test('the reading’s own error is taken off before it counts', () => {
  // 550 m out, but only good to 300 m: he could be 250 m away, still nearby.
  assert.equal(leftShopVerdict(base({ fix: { ...northOf(550), accuracyM: 300, at: 2_000 } })).left, false);
  // No stated accuracy proves nothing.
  assert.equal(leftShopVerdict(base({ fix: { ...northOf(2_000), accuracyM: null, at: 2_000 } })).left, false);
});

test('asked once per visit, and never before he went in', () => {
  assert.equal(leftShopVerdict(base({ alreadyAsked: true })).left, false);
  assert.equal(leftShopVerdict(base({ checkedInAt: null })).left, false);
  assert.equal(leftShopVerdict(base({ fix: { ...northOf(700), accuracyM: 20, at: 500 } })).left, false);
});

test('nothing to measure from means nothing is claimed', () => {
  assert.equal(leftShopVerdict(base({ anchor: null })).left, false);
});
