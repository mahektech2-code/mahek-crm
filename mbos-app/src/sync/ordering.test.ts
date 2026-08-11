import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffFor, dependents, MAX_ATTEMPTS, partition, type Eligible } from './ordering';

/**
 * The Phase 0 gate, in tests.
 *
 * The scenario the whole architecture exists for: a salesman offline creates a
 * visit, punches an order from inside it, and collects a payment against that
 * order. Three records, two dependencies, none of them on a server yet.
 */

function item(id: string, entityId: string, dependsOn: string[] = [], over: Partial<Eligible> = {}): Eligible {
  return { id, entityId, dependsOn, nextAttemptAt: 0, createdAt: 0, state: 'queued', ...over };
}

const NOW = 1_000_000;

test('a payment never goes out before the order it depends on', () => {
  /* Deliberately queued in the wrong order — creation order must not win. */
  const queued = [
    item('q3', 'payment1', ['order1'], { createdAt: 3 }),
    item('q2', 'order1', ['visit1'], { createdAt: 2 }),
    item('q1', 'visit1', [], { createdAt: 1 }),
  ];

  const { ready } = partition({ queued, syncedIds: new Set(), deadIds: new Set(), now: NOW });

  assert.deepEqual(ready.map((r) => r.entityId), ['visit1', 'order1', 'payment1']);
});

test('all three leave on one pass, satisfying each other as they go', () => {
  const queued = [
    item('q1', 'visit1', [], { createdAt: 1 }),
    item('q2', 'order1', ['visit1'], { createdAt: 2 }),
    item('q3', 'payment1', ['order1'], { createdAt: 3 }),
  ];
  const { ready, waiting } = partition({ queued, syncedIds: new Set(), deadIds: new Set(), now: NOW });
  assert.equal(ready.length, 3);
  assert.equal(waiting.length, 0);
});

test('a rejected order blocks its payment rather than orphaning it', () => {
  const queued = [item('q3', 'payment1', ['order1'])];
  const { ready, blocked } = partition({
    queued,
    syncedIds: new Set(),
    deadIds: new Set(['order1']),
    now: NOW,
  });

  assert.equal(ready.length, 0, 'the payment must not be sent');
  assert.deepEqual(blocked.map((b) => b.entityId), ['payment1']);
});

test('blocking is transitive — anything behind a dead record is dead too', () => {
  const queued = [
    item('q2', 'payment1', ['order1'], { createdAt: 2 }),
    item('q3', 'receipt1', ['payment1'], { createdAt: 3 }),
  ];
  const { blocked, ready } = partition({
    queued,
    syncedIds: new Set(),
    deadIds: new Set(['order1']),
    now: NOW,
  });

  assert.equal(ready.length, 0);
  assert.deepEqual(blocked.map((b) => b.entityId).sort(), ['payment1', 'receipt1']);
});

test('a dependency already synced on a previous pass makes its dependent ready', () => {
  const queued = [item('q2', 'order1', ['visit1'])];
  const { ready } = partition({ queued, syncedIds: new Set(['visit1']), deadIds: new Set(), now: NOW });
  assert.deepEqual(ready.map((r) => r.entityId), ['order1']);
});

test('an item still inside its backoff window waits, and does not block others', () => {
  const queued = [
    item('q1', 'visit1', [], { nextAttemptAt: NOW + 60_000 }),
    item('q2', 'task1', []),
  ];
  const { ready, waiting } = partition({ queued, syncedIds: new Set(), deadIds: new Set(), now: NOW });

  assert.deepEqual(ready.map((r) => r.entityId), ['task1']);
  assert.deepEqual(waiting.map((w) => w.entityId), ['visit1']);
});

test('a dependent waits — it is not blocked — while its dependency is backing off', () => {
  const queued = [
    item('q1', 'visit1', [], { nextAttemptAt: NOW + 60_000 }),
    item('q2', 'order1', ['visit1']),
  ];
  const { ready, waiting, blocked } = partition({ queued, syncedIds: new Set(), deadIds: new Set(), now: NOW });

  assert.equal(ready.length, 0);
  assert.equal(blocked.length, 0, 'a slow dependency is not a dead one');
  assert.equal(waiting.length, 2);
});

test('the batch limit never breaks dependency order', () => {
  const queued = [
    item('q1', 'visit1', [], { createdAt: 1 }),
    item('q2', 'order1', ['visit1'], { createdAt: 2 }),
    item('q3', 'payment1', ['order1'], { createdAt: 3 }),
  ];
  const { ready } = partition({ queued, syncedIds: new Set(), deadIds: new Set(), now: NOW, limit: 2 });

  assert.equal(ready.length, 2);
  assert.deepEqual(ready.map((r) => r.entityId), ['visit1', 'order1']);
});

test('backoff grows and then caps, and stays above the current time', () => {
  const zero = backoffFor(0, NOW, 0);
  const one = backoffFor(1, NOW, 0);
  const capped = backoffFor(99, NOW, 0);

  assert.equal(zero, NOW + 2_000);
  assert.ok(one > zero);
  assert.equal(capped, backoffFor(MAX_ATTEMPTS - 1, NOW, 0));
  assert.ok(capped > NOW);
});

test('jitter never pulls an attempt earlier than its base delay', () => {
  for (const j of [0, 0.5, 0.999]) {
    assert.ok(backoffFor(2, NOW, j) >= NOW + 30_000);
  }
});

test('dependents finds the whole subtree behind a record', () => {
  const items = [
    item('q2', 'order1', ['visit1']),
    item('q3', 'payment1', ['order1']),
    item('q4', 'unrelated', []),
  ];
  const out = dependents(items, 'visit1');
  assert.deepEqual(out.map((o) => o.entityId).sort(), ['order1', 'payment1']);
});

test('an interrupted pass loses nothing — the same queue re-partitions identically', () => {
  /* This is the restart case. Nothing about eligibility is held in memory, so
     re-deriving it from the same rows must give the same answer. */
  const queued = [
    item('q1', 'visit1', [], { createdAt: 1 }),
    item('q2', 'order1', ['visit1'], { createdAt: 2 }),
  ];
  const first = partition({ queued, syncedIds: new Set(), deadIds: new Set(), now: NOW });
  const second = partition({ queued, syncedIds: new Set(), deadIds: new Set(), now: NOW });

  assert.deepEqual(first.ready.map((r) => r.id), second.ready.map((r) => r.id));
});
