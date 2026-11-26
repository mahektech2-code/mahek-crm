import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../db/schema';
import { SHOP_CREATE_REFUSED_SQL, shopOrderRefusal, shopRefusalLine } from './shop-refusal';

/**
 * A shop added at a counter that the office refused used to look like every
 * other shop for ever. The row now carries the outbox's answer, the card says
 * it, and a new order is refused at the door. Run against the REAL schema.
 */

function handset(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const step of MIGRATIONS) for (const stmt of step) db.exec(stmt);
  return db;
}

function queue(db: DatabaseSync, id: string, entityId: string, op: string, state: string, reason: string | null = null) {
  db.prepare(
    `INSERT INTO sync_queue (id, entityType, entityId, op, payload, dependsOn, idempotencyKey, nextAttemptAt, state, failureReason, createdAt)
     VALUES (?, 'customer', ?, ?, '{}', '[]', ?, 0, ?, ?, 0)`,
  ).run(id, entityId, op, id, state, reason);
}

test('every shop the office sent reads as synced; the columns the wire now sends have a home', () => {
  const db = handset();
  db.prepare(`INSERT INTO customers (id, name) VALUES ('c1', 'Sai Paints')`).run();
  const row = { ...(db.prepare('SELECT syncState, syncMessage, address, serverUpdatedAt FROM customers').get() as Record<string, unknown>) };
  assert.deepEqual(row, { syncState: 'synced', syncMessage: null, address: null, serverUpdatedAt: null });
});

test("a refused create is read off the outbox with the office's reason; a queued one is not refused", () => {
  const db = handset();
  queue(db, 'q1', 'shop_refused', 'create', 'rejected', 'This number is already Sai Paints.');
  queue(db, 'q2', 'shop_waiting', 'create', 'queued');
  queue(db, 'q3', 'shop_edit_refused', 'update', 'rejected', 'already has a pin');
  const refused = db.prepare(SHOP_CREATE_REFUSED_SQL).get('shop_refused') as { reason: string } | undefined;
  assert.equal(refused?.reason, 'This number is already Sai Paints.');
  assert.equal(db.prepare(SHOP_CREATE_REFUSED_SQL).get('shop_waiting'), undefined, 'still on its way: the order waits behind it');
  assert.equal(db.prepare(SHOP_CREATE_REFUSED_SQL).get('shop_edit_refused'), undefined, 'a refused EDIT does not stop orders');
});

test('the order refusal and the card say why, in the office’s words', () => {
  assert.match(shopOrderRefusal('Sai Paints', 'This number is already on the book.'), /did not take Sai Paints — This number is already on the book\. An order/);
  assert.match(shopOrderRefusal('Sai Paints', null), /did not take Sai Paints\. An order/);
  assert.equal(shopRefusalLine({ syncState: 'synced' }), null);
  assert.equal(shopRefusalLine({ syncState: 'queued' }), null);
  assert.equal(shopRefusalLine({ syncState: 'rejected', syncMessage: 'No distributor.' }), 'No distributor.');
  assert.match(shopRefusalLine({ syncState: 'blocked', syncMessage: null }) ?? '', /did not take this shop/);
});

test('the outbox writes its answer back onto a shop row', () => {
  const src = readFileSync(join(import.meta.dirname, '../sync/queue.ts'), 'utf8');
  assert.match(src, /customer: 'customers'/);
});
