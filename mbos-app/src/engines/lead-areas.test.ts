import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaRule } from './lead-areas';

test('an older server sends no areas, and the form stays free', () => {
  assert.deepEqual(areaRule(null), { kind: 'free' });
  assert.deepEqual(areaRule({ exempt: false }), { kind: 'free' });
});

test('nowhere allocated: a salesman may not raise a lead, a manager may', () => {
  assert.deepEqual(areaRule({ exempt: false, areas: [] }), { kind: 'none' });
  assert.deepEqual(areaRule({ exempt: true, areas: [] }), { kind: 'free' });
});

test('a city carries its state; a state leaves the town to be typed', () => {
  const rule = areaRule({
    exempt: true,
    areas: [
      { kind: 'region', value: 'Maharashtra', parent: null },
      { kind: 'city', value: 'Thane', parent: 'Maharashtra' },
      { kind: 'state', value: 'Maharashtra', parent: null },
    ],
  });
  assert.equal(rule.kind, 'pick');
  if (rule.kind !== 'pick') return;
  assert.deepEqual(
    rule.choices.map((c) => [c.label, c.city, c.state]),
    [
      ['Thane · Maharashtra', 'Thane', 'Maharashtra'],
      ['Maharashtra', null, 'Maharashtra'],
    ],
  );
});

test('a beat fills the town and the locality', () => {
  const rule = areaRule({ exempt: false, areas: [{ kind: 'beat', value: 'Sadar', parent: 'Nagpur' }] });
  assert.equal(rule.kind, 'pick');
  if (rule.kind !== 'pick') return;
  assert.deepEqual(rule.choices[0], { key: 'beat|sadar|nagpur', label: 'Sadar · Nagpur', city: 'Nagpur', area: 'Sadar', state: null });
});
