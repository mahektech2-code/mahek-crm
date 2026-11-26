import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../db/schema';
import { IN_FLIGHT_LEG_SHOPS_SQL, IN_FLIGHT_LEG_WINDOW_MS } from './day-shape';

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
