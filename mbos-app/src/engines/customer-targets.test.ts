import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysSince,
  gapPaise,
  lastOrderWords,
  matches,
  sortForWork,
  stateOf,
  summarise,
  type CustomerTargetRow,
} from './customer-targets';

const row = (over: Partial<CustomerTargetRow>): CustomerTargetRow => ({
  customerId: over.name ?? 'x',
  name: 'Shop',
  city: null,
  targetPaise: 0,
  achievedPaise: 0,
  pendingPaise: 0,
  unsentPaise: 0,
  isDefault: false,
  carriedForward: false,
  lastOrderDate: null,
  ...over,
});

test('a shop with no target is untargeted, never met', () => {
  assert.equal(stateOf(row({ targetPaise: 0, achievedPaise: 5000 })), 'untargeted');
  assert.equal(matches(row({ targetPaise: 0, achievedPaise: 5000 }), 'met'), false);
  assert.equal(matches(row({ targetPaise: 0 }), 'all'), true);
});

test('the states, and "still open" includes shops that bought nothing', () => {
  const nothing = row({ targetPaise: 10_000 });
  const part = row({ targetPaise: 10_000, achievedPaise: 4_000 });
  const met = row({ targetPaise: 10_000, achievedPaise: 12_000 });
  assert.equal(stateOf(nothing), 'not-started');
  assert.equal(stateOf(part), 'open');
  assert.equal(stateOf(met), 'met');
  assert.ok(matches(nothing, 'open') && matches(part, 'open') && !matches(met, 'open'));
  assert.ok(matches(nothing, 'not-started') && !matches(part, 'not-started'));
});

test('pending money is never counted as achieved', () => {
  const r = row({ targetPaise: 10_000, achievedPaise: 0, pendingPaise: 10_000 });
  assert.equal(stateOf(r), 'not-started');
  assert.equal(gapPaise(r), 10_000);
});

test('biggest gap first, then biggest target, then name', () => {
  const sorted = sortForWork([
    row({ name: 'B', targetPaise: 5_000, achievedPaise: 5_000 }),
    row({ name: 'A', targetPaise: 9_000, achievedPaise: 9_000 }),
    row({ name: 'C', targetPaise: 20_000, achievedPaise: 2_000 }),
    row({ name: 'D', targetPaise: 10_000 }),
  ]).map((r) => r.name);
  assert.deepEqual(sorted, ['C', 'D', 'A', 'B']);
});

test('the open figure is each shop’s own gap — an over-target shop pays nothing down', () => {
  const s = summarise([
    row({ targetPaise: 10_000, achievedPaise: 30_000 }),
    row({ targetPaise: 10_000, achievedPaise: 4_000, pendingPaise: 1_000, unsentPaise: 500 }),
    row({ targetPaise: 0, achievedPaise: 2_000 }),
  ]);
  assert.equal(s.targeted, 2);
  assert.equal(s.targetPaise, 20_000);
  assert.equal(s.achievedPaise, 36_000);
  assert.equal(s.openPaise, 6_000);
  assert.equal(s.waitingPaise, 1_500);
  assert.deepEqual(s.counts, { open: 1, 'not-started': 0, met: 1, all: 3 });
});

test('days since the last order, in words', () => {
  assert.equal(daysSince('2026-09-20', '2026-10-02'), 12);
  assert.equal(daysSince(null, '2026-10-02'), null);
  assert.equal(daysSince('2026-10-05', '2026-10-02'), null);
  assert.equal(lastOrderWords('2026-10-02', '2026-10-02'), 'Ordered today');
  assert.equal(lastOrderWords('2026-10-01', '2026-10-02'), 'Last order yesterday');
  assert.equal(lastOrderWords('2026-09-20', '2026-10-02'), 'Last order 12 days ago');
  assert.equal(lastOrderWords(null, '2026-10-02'), 'No order on record');
});
