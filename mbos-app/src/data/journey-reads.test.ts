import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../db/schema';

/**
 * THE READS BEHIND A DAY THAT IS NOT TODAY, against a REAL SQLite carrying the
 * REAL schema — the pattern `statement-reads.test.ts` follows and for its
 * reason: `data/journey.ts` imports the database, which cannot load under
 * `tsx --test`, so the SQL is restated here. Any change to a query has to be
 * made in both.
 *
 * Two things are pinned. Every statement `dayHistory` and `pickedShops` run
 * PREPARES against the handset's schema — a column named wrongly in a SQL
 * string is invisible to the type checker and is a sheet that never opens.
 * And `pickedFor`'s precedence: an edit not yet sent is the newer answer, so
 * reopening a day he has just changed must show the change, not the stops the
 * office last sent.
 */

function handset(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const step of MIGRATIONS) for (const stmt of step) db.exec(stmt);
  return db;
}

const QUEUED = `SELECT pickedIds FROM journey_days WHERE id = ? AND syncState = 'queued' AND pickedIds IS NOT NULL`;
const STOPS_FOR_DAY = `SELECT s.customerId FROM journey_stops s
       JOIN journey_days d ON d.planDate = s.planDate
      WHERE d.id = ? ORDER BY s.seq`;
const PICKED_IDS = 'SELECT pickedIds FROM journey_days WHERE id = ?';

/* The same three steps `pickedFor` takes, in its order. */
function pickedFor(db: DatabaseSync, id: string): string[] {
  const queued = db.prepare(QUEUED).get(id) as { pickedIds: string } | undefined;
  if (queued?.pickedIds) return JSON.parse(queued.pickedIds) as string[];
  const rows = db.prepare(STOPS_FOR_DAY).all(id) as { customerId: string }[];
  if (rows.length) return rows.map((r) => r.customerId);
  const day = db.prepare(PICKED_IDS).get(id) as { pickedIds: string | null } | undefined;
  return day?.pickedIds ? (JSON.parse(day.pickedIds) as string[]) : [];
}

function day(db: DatabaseSync, id: string, date: string, syncState: string, picked: string[] | null) {
  db.prepare(
    `INSERT INTO journey_days (id, planDate, city, dayState, picked, selfPlanned, syncState, pickedIds)
     VALUES (?, ?, 'Nagpur', 'planned', ?, 0, ?, ?)`,
  ).run(id, date, picked?.length ?? 0, syncState, picked ? JSON.stringify(picked) : null);
}

function stop(db: DatabaseSync, id: string, date: string, customerId: string, seq: number) {
  db.prepare(
    `INSERT INTO journey_stops (id, planDate, customerId, seq, status) VALUES (?, ?, ?, ?, 'planned')`,
  ).run(id, date, customerId, seq);
}

test('an unsent edit is what reopening the day shows, not the stops the office sent', () => {
  const db = handset();
  day(db, 'd1', '2026-10-06', 'queued', ['c3', 'c1']);
  stop(db, 's1', '2026-10-06', 'c1', 1);
  stop(db, 's2', '2026-10-06', 'c2', 2);
  assert.deepEqual(pickedFor(db, 'd1'), ['c3', 'c1']);
});

test('once the office has the day, its stops are the answer', () => {
  const db = handset();
  day(db, 'd1', '2026-10-06', 'synced', ['c9']);
  stop(db, 's1', '2026-10-06', 'c1', 1);
  stop(db, 's2', '2026-10-06', 'c2', 2);
  assert.deepEqual(pickedFor(db, 'd1'), ['c1', 'c2']);
});

test('a day picked and never routed falls back to what was picked', () => {
  const db = handset();
  day(db, 'd1', '2026-10-06', 'synced', ['c4', 'c5']);
  assert.deepEqual(pickedFor(db, 'd1'), ['c4', 'c5']);
});

test('every read behind a past day and a planned day prepares against the handset schema', () => {
  const db = handset();
  const one = '?';
  const statements = [
    `SELECT id, name, area, city, outstandingPaise FROM customers WHERE id IN (${one})`,
    `SELECT s.id, s.customerId, s.seq, s.status, s.plannedAt, s.actualAt, s.skipReason,
            c.name, c.area, c.city
       FROM journey_stops s
       LEFT JOIN customers c ON c.id = s.customerId
      WHERE s.planDate = ?
      ORDER BY s.seq`,
    `SELECT customerId, checkInAt, checkOutAt, durationSeconds, outcome, notes FROM visits
        WHERE customerId IN (${one}) AND checkInAt BETWEEN ? AND ? ORDER BY checkInAt`,
    `SELECT id, customerId, orderedAt, netTotalPaise, orderNumber FROM orders
        WHERE customerId IN (${one}) AND orderedAt BETWEEN ? AND ?`,
    `SELECT id, customerId, valuePaise, lines, orderNo FROM customer_orders
        WHERE customerId IN (${one}) AND orderedAt = ?`,
    `SELECT id, customerId, amountPaise, mode, collectedAt FROM payments
        WHERE customerId IN (${one}) AND collectedAt BETWEEN ? AND ?`,
    `SELECT id, customerId, amountPaise, mode FROM customer_payments
        WHERE customerId IN (${one}) AND substr(receivedAt, 1, 10) = ?`,
    `SELECT id, customerId, eventType, summary, occurredAt FROM timeline_events
        WHERE customerId IN (${one}) AND occurredAt BETWEEN ? AND ? ORDER BY occurredAt`,
    `SELECT orderId, productName, cans FROM order_lines WHERE orderId IN (${one})`,
  ];
  for (const sql of statements) assert.doesNotThrow(() => db.prepare(sql), sql.slice(0, 60));
});

test("the office's order dates are Kolkata dates, so one day's orders are matched exactly", () => {
  const db = handset();
  db.prepare(
    `INSERT INTO customer_orders (id, customerId, orderedAt, status, valuePaise, lines, orderNo)
     VALUES ('o1', 'c1', '2026-10-02', 'dispatched', 431900, 2, 'MB-00524'),
            ('o2', 'c1', '2026-10-01', 'dispatched', 100000, 1, 'MB-00500')`,
  ).run();
  const rows = db
    .prepare(`SELECT id FROM customer_orders WHERE customerId IN (?) AND orderedAt = ?`)
    .all('c1', '2026-10-02') as { id: string }[];
  assert.deepEqual(rows.map((r) => r.id), ['o1']);
});
