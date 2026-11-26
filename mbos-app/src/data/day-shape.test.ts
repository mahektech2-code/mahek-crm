import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../db/schema';
import {
  IN_FLIGHT_LEG_SHOPS_SQL,
  IN_FLIGHT_LEG_WINDOW_MS,
  PIN_UNPINNED_SHOP_SQL,
  adoptsServerId,
  moveDraft,
  repointDependsOn,
  repointPayload,
} from './day-shape';
import { landedDependencies } from '../sync/ordering';

/**
 * The edges of a field day, run against the REAL handset schema. See
 * `day-shape.ts` for why each statement lives there rather than beside the
 * screen that uses it.
 */

function handset(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const step of MIGRATIONS) for (const stmt of step) db.exec(stmt);
  return db;
}

const NOW = 1_800_000_000_000;

function leg(db: DatabaseSync, o: { id: string; customerId: string; endedAt: number | null; visitId?: string | null; origin?: string }) {
  db.prepare(
    `INSERT INTO travel_legs (id, userId, modeKey, customerId, visitId, startedAt, endedAt, origin, clientCreatedAt, deviceId)
     VALUES (?, 'u1', 'own_bike', ?, ?, ?, ?, ?, ?, 'd1')`,
  ).run(o.id, o.customerId, o.visitId ?? null, NOW - 3_600_000, o.endedAt, o.origin ?? 'visit', NOW - 3_600_000);
}

test('a shop he is riding to, or reached and has not yet visited, is held on the phone', () => {
  const db = handset();
  leg(db, { id: 'l1', customerId: 'riding_to', endedAt: null });
  leg(db, { id: 'l2', customerId: 'arrived_at', endedAt: NOW - 600_000 });
  leg(db, { id: 'l3', customerId: 'visited', endedAt: NOW - 600_000, visitId: 'v1' });
  leg(db, { id: 'l4', customerId: 'abandoned_last_week', endedAt: NOW - 7 * 86_400_000 });
  leg(db, { id: 'l5', customerId: 'session', endedAt: null, origin: 'session' });
  const ids = (db.prepare(IN_FLIGHT_LEG_SHOPS_SQL).all(NOW - IN_FLIGHT_LEG_WINDOW_MS) as { customerId: string }[])
    .map((r) => r.customerId)
    .sort();
  assert.deepEqual(ids, ['arrived_at', 'riding_to']);
});

test('opening another shop mid-visit sets the visit cart aside, and it comes back', () => {
  const inVisit = { cartFor: 'shopA', cart: { sku1: '3' }, oQ: 'ena', payMode: 'cash', payAmt: '500', payChq: '', visitCartStash: null };
  const away = moveDraft(inVisit, 'shopB', 'shopA');
  assert.deepEqual(away.cart, {}, 'the other shop opens on an empty cart');
  assert.equal(away.cartFor, 'shopB');
  assert.deepEqual(away.visitCartStash?.cart, { sku1: '3' });

  const there = { ...inVisit, ...away } as typeof inVisit;
  const back = moveDraft(there, 'shopA', 'shopA');
  assert.deepEqual(back.cart, { sku1: '3' }, 'the visit cart is back');
  assert.equal(back.payAmt, '500');
  assert.equal(back.visitCartStash, null);

  /* No visit running: the old rule, a cleared draft and nothing kept. */
  const plain = moveDraft(inVisit, 'shopB', null);
  assert.deepEqual(plain.cart, {});
  assert.equal(plain.visitCartStash, null);
  /* Same shop again changes nothing. */
  assert.deepEqual(moveDraft(inVisit, 'shopA', 'shopA'), {});
});

test('a day the office answered with its own id is adopted, and the picks follow it', () => {
  assert.equal(adoptsServerId({ entityType: 'plan_day', op: 'create', entityId: 'plan_mine' }, 'plan_office'), true);
  assert.equal(adoptsServerId({ entityType: 'plan_day', op: 'create', entityId: 'plan_mine' }, 'plan_mine'), false);
  assert.equal(adoptsServerId({ entityType: 'plan_day', op: 'update', entityId: 'plan_mine' }, 'plan_office'), false);
  assert.equal(adoptsServerId({ entityType: 'order', op: 'create', entityId: 'o1' }, 'o2'), false);

  const picks = JSON.stringify({ id: 'plan_mine', customerIds: ['c1', 'c2'] });
  assert.deepEqual(JSON.parse(repointPayload(picks, 'plan_mine', 'plan_office')), { id: 'plan_office', customerIds: ['c1', 'c2'] });
  assert.equal(repointPayload('{"id":"other"}', 'plan_mine', 'plan_office'), '{"id":"other"}');
  assert.equal(repointPayload('nonsense', 'plan_mine', 'plan_office'), 'nonsense');
  assert.equal(repointDependsOn('["plan_mine","x"]', 'plan_mine', 'plan_office'), '["plan_office","x"]');
  assert.equal(repointDependsOn('[]', 'plan_mine', 'plan_office'), '[]');
});

test('picks sharing the day id are never held behind themselves', () => {
  /* The day's create is gone from the outbox (pruned, or the office made it):
     the picks waiting on that id are waiting on nothing. */
  const alone = landedDependencies([{ entityId: 'd1', entityType: 'plan_stops', dependsOn: ['d1'] }], [], new Set());
  assert.ok(alone.has('d1'));
  /* An earlier set of picks for the same day is not what they wait on either. */
  const twice = landedDependencies(
    [
      { entityId: 'd1', entityType: 'plan_stops', dependsOn: ['d1'] },
      { entityId: 'd1', entityType: 'plan_stops', dependsOn: ['d1'] },
    ],
    [],
    new Set(),
  );
  assert.ok(twice.has('d1'));
  /* The day's create still waiting: they wait for it. */
  const behind = landedDependencies(
    [
      { entityId: 'd1', entityType: 'plan_day', dependsOn: [] },
      { entityId: 'd1', entityType: 'plan_stops', dependsOn: ['d1'] },
    ],
    [],
    new Set(),
  );
  assert.equal(behind.has('d1'), false);
  /* Refused: never landed, and the ordering blocks them. */
  assert.equal(landedDependencies([{ entityId: 'd1', entityType: 'plan_stops', dependsOn: ['d1'] }], [], new Set(['d1'])).has('d1'), false);
  /* An order waiting on a lead still behaves exactly as before. */
  const order = landedDependencies(
    [
      { entityId: 'lead1', entityType: 'lead', dependsOn: [] },
      { entityId: 'o1', entityType: 'order', dependsOn: ['lead1'] },
    ],
    [],
    new Set(),
  );
  assert.equal(order.has('lead1'), false);
});

test('the first check-in pins an unpinned shop on the phone, and never moves a pin', () => {
  const db = handset();
  db.prepare("INSERT INTO customers (id, name) VALUES ('bare', 'No Pin Traders')").run();
  db.prepare("INSERT INTO customers (id, name, gpsLat, gpsLng) VALUES ('pinned', 'Pinned Paints', 21.1, 79.1)").run();
  db.prepare(PIN_UNPINNED_SHOP_SQL).run(21.2, 79.2, 12, 'bare');
  db.prepare(PIN_UNPINNED_SHOP_SQL).run(21.9, 79.9, 12, 'pinned');
  const rows = db.prepare('SELECT id, gpsLat, gpsLng, gpsAccuracyM FROM customers ORDER BY id').all() as Record<string, unknown>[];
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { id: 'bare', gpsLat: 21.2, gpsLng: 79.2, gpsAccuracyM: 12 },
    { id: 'pinned', gpsLat: 21.1, gpsLng: 79.1, gpsAccuracyM: null },
  ]);
});
