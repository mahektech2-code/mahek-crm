import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locationLine, matchLocation } from './lead-scan';
import type { AreaChoice, AreaRule } from './lead-areas';

const nagpur: AreaChoice = { key: 'c:nagpur', label: 'Nagpur', city: 'Nagpur', area: null, state: 'Maharashtra' };
const itwari: AreaChoice = { key: 'b:itwari', label: 'Itwari', city: 'Nagpur', area: 'Itwari', state: 'Maharashtra' };
const gujarat: AreaChoice = { key: 's:gj', label: 'Gujarat', city: null, area: null, state: 'Gujarat' };
const pick = (...choices: AreaChoice[]): AreaRule => ({ kind: 'pick', choices });

test('a scanned town picks his area of that name, whatever its case', () => {
  assert.deepEqual(matchLocation(pick(nagpur, gujarat), 'NAGPUR', 'Maharashtra'), {
    kind: 'area',
    area: nagpur,
    city: null,
  });
});

test('a locality matches the beat that names it', () => {
  assert.deepEqual(matchLocation(pick(itwari), 'Itwari', null), { kind: 'area', area: itwari, city: null });
});

test('a state-level area takes the town from the card', () => {
  assert.deepEqual(matchLocation(pick(nagpur, gujarat), 'Surat', 'Gujarat'), {
    kind: 'area',
    area: gujarat,
    city: 'Surat',
  });
});

test('a town in none of his areas is said, never typed into a box the save refuses', () => {
  assert.deepEqual(matchLocation(pick(nagpur), 'Pune', 'Maharashtra'), { kind: 'outside', city: 'Pune' });
});

test('with no areas to pick from the town goes in as written', () => {
  assert.deepEqual(matchLocation({ kind: 'free' }, 'Wardha', null), { kind: 'free', city: 'Wardha' });
  assert.equal(matchLocation({ kind: 'free' }, null, 'Maharashtra'), null);
});

test('a location line names what was found and nothing else', () => {
  assert.equal(locationLine('Nagpur', 'Maharashtra'), 'Nagpur, Maharashtra');
  assert.equal(locationLine(null, 'Maharashtra'), 'Maharashtra');
  assert.equal(locationLine(null, null), null);
});
