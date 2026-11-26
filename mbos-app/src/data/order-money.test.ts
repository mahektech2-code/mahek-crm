import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../db/schema';
import {
  LOCAL_ORDERS_FOR_SHOP_SQL,
  mergeShopOrders,
  OPEN_BILLS_FOR_GATES_SQL,
  UNSENT_CREATE_SQL,
  UNSENT_ORDERS_PAISE_SQL,
} from './order-money';
import {
  expenseTombstoneStatement,
  myPaymentStatements,
  openOrderedStatements,
  priceKeyStatements,
  type Statement,
} from '../sync/money-channels';

/**
 * The money an order commits and the four money channels on the pull, run
 * against the REAL handset schema.
 */

function handset(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const step of MIGRATIONS) for (const stmt of step) db.exec(stmt);
  return db;
}

const exec = (db: DatabaseSync, statements: Statement[]) => {
  for (const [sql, params] of statements) db.prepare(sql).run(...params);
};

function order(db: DatabaseSync, id: string, o: { customerId?: string; delivery?: string | null; paise?: number; status?: string; syncState?: string; queue?: string | null; at?: number } = {}) {
  db.prepare(
    `INSERT INTO orders (id, customerId, deliveryCustomerId, userId, orderedAt, status, netTotalPaise, clientCreatedAt, deviceId, syncState)
     VALUES (?, ?, ?, 'u1', ?, ?, ?, 0, 'd1', ?)`,
  ).run(id, o.customerId ?? 'biller', o.delivery ?? null, o.at ?? 1, o.status ?? 'submitted', o.paise ?? 10_000, o.syncState ?? 'queued');
  if (o.queue !== null) {
    db.prepare(
      `INSERT INTO sync_queue (id, entityType, entityId, op, payload, dependsOn, idempotencyKey, nextAttemptAt, state, createdAt)
       VALUES (?, 'order', ?, 'create', '{}', '[]', ?, 0, ?, 0)`,
    ).run('q_' + id, id, 'k_' + id, o.queue ?? 'queued');
  }
}

test('ordered-not-invoiced adds only orders whose create has not left this phone', () => {
  const db = handset();
  order(db, 'o1', { paise: 10_000, queue: 'queued' });
  order(db, 'o2', { paise: 20_000, queue: 'failed' });
  order(db, 'o3', { paise: 40_000, queue: 'synced', syncState: 'synced' }); // in the office's figure already
  order(db, 'o4', { paise: 80_000, queue: 'rejected', syncState: 'rejected' }); // in nobody's
  order(db, 'o5', { paise: 160_000, queue: 'queued', status: 'cancelled' });
  order(db, 'o6', { paise: 320_000, customerId: 'other' });
  const get = (exclude: string) => (db.prepare(UNSENT_ORDERS_PAISE_SQL).get('biller', exclude) as { paise: number }).paise;
  assert.equal(get(''), 30_000);
  assert.equal(get('o2'), 10_000, 'the order being edited is judged at its new value, not counted twice');
});

test("the office's figure replaces the phone's, and a shop it does not list is zeroed", () => {
  const db = handset();
  db.prepare("INSERT INTO customers (id, name, submittedNotInvoicedPaise) VALUES ('a', 'A', 999), ('b', 'B', 999)").run();
  exec(db, openOrderedStatements([{ customerId: 'a', paise: 12_345 }]));
  const rows = db.prepare('SELECT id, submittedNotInvoicedPaise AS p FROM customers ORDER BY id').all() as { id: string; p: number }[];
  assert.deepEqual(rows.map((r) => [r.id, r.p]), [['a', 12_345], ['b', 0]]);
  exec(db, openOrderedStatements(undefined));
  assert.equal((db.prepare("SELECT submittedNotInvoicedPaise AS p FROM customers WHERE id = 'a'").get() as { p: number }).p, 12_345, 'an older server that sends nothing changes nothing');
});

test('only an order still in the outbox, and not in flight, can be taken back on the phone', () => {
  const db = handset();
  order(db, 'o1', { queue: 'queued' });
  order(db, 'o2', { queue: 'syncing' });
  order(db, 'o3', { queue: 'synced', syncState: 'synced' });
  assert.ok(db.prepare(UNSENT_CREATE_SQL).get('o1'));
  assert.equal(db.prepare(UNSENT_CREATE_SQL).get('o2'), undefined);
  assert.equal(db.prepare(UNSENT_CREATE_SQL).get('o3'), undefined);
});

test("a shop's Orders tab gets his unsent orders billed to it and delivered to it", () => {
  const db = handset();
  order(db, 'mine', { customerId: 'shop', at: Date.parse('2026-11-26T10:00:00+05:30') });
  order(db, 'deliv', { customerId: 'dist', delivery: 'shop', at: Date.parse('2026-11-25T10:00:00+05:30') });
  order(db, 'landed', { customerId: 'shop', syncState: 'synced', queue: 'synced' });
  const local = db.prepare(LOCAL_ORDERS_FOR_SHOP_SQL).all('shop', 'shop') as never[];
  const merged = mergeShopOrders(
    [{ id: 'office1', customerId: 'shop', orderedAt: '2026-11-20', status: 'confirmed', valuePaise: 1, lines: 1, orderNo: 'X' }],
    local,
    (ms) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10),
  );
  assert.deepEqual(merged.map((m) => [m.id, m.orderedAt, !!m.pending]), [
    ['mine', '2026-11-26', true],
    ['deliv', '2026-11-25', true],
    ['office1', '2026-11-20', false],
  ]);
});

test('the overdue rule reads every open bill, settled ones left out', () => {
  const db = handset();
  db.prepare(
    `INSERT INTO customer_bills (id, customerId, billNo, billDate, dueDate, balancePaise, paymentPosition) VALUES
       ('b1', 'c', 'OLD', '2024-01-01', '2024-02-01', 500, 'stated'),
       ('b2', 'c', 'PAID', '2024-01-01', '2024-02-01', 0, 'stated')`,
  ).run();
  const rows = db.prepare(OPEN_BILLS_FOR_GATES_SQL).all('c') as { billNo: string }[];
  assert.deepEqual(rows.map((r) => r.billNo), ['OLD']);
});

test('price keys and dashes are replaced whole; an absent channel leaves them', () => {
  const db = handset();
  exec(db, priceKeyStatements([{ customerId: 'c1', priceKey: 'T::pl' }], [{ priceKey: 'T::pl', productId: 'p9' }]));
  exec(db, priceKeyStatements([{ customerId: 'c2', priceKey: 'T::pl2' }], undefined));
  assert.deepEqual(db.prepare('SELECT customerId FROM customer_price_keys').all().map((r) => (r as { customerId: string }).customerId), ['c2']);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM price_unoffered').get() as { n: number }).n, 1);
});

test("the office's word on a receipt lands on his payment, with the real number", () => {
  const db = handset();
  db.prepare(
    `INSERT INTO payments (id, customerId, userId, amountPaise, mode, collectedAt, localReceiptRef, clientCreatedAt, deviceId)
     VALUES ('pay1', 'c', 'u', 100, 'Cash', 0, 'TMP-1', 0, 'd')`,
  ).run();
  exec(db, myPaymentStatements([{ id: 'pay1', status: 'rejected', receiptNo: 'MRCP/26-27/9', reason: 'Not in the bank', decidedAt: 5 }]));
  const row = db.prepare("SELECT officeStatus, officeReason, receiptNumber FROM payments WHERE id = 'pay1'").get() as Record<string, unknown>;
  assert.deepEqual({ ...row }, { officeStatus: 'rejected', officeReason: 'Not in the bank', receiptNumber: 'MRCP/26-27/9' });
});

test('an expense tombstone removes a synced line and never one still in the outbox', () => {
  const db = handset();
  for (const [id, state] of [['e1', 'synced'], ['e2', 'queued']] as const) {
    db.prepare(
      `INSERT INTO expenses (id, userId, spentOn, category, amountPaise, clientCreatedAt, deviceId, syncState)
       VALUES (?, 'u', '2026-11-01', 'Food', 100, 0, 'd', ?)`,
    ).run(id, state);
  }
  db.prepare(
    `INSERT INTO sync_queue (id, entityType, entityId, op, payload, dependsOn, idempotencyKey, nextAttemptAt, state, createdAt)
     VALUES ('q', 'expense', 'e2', 'create', '{}', '[]', 'k', 0, 'queued', 0)`,
  ).run();
  exec(db, [expenseTombstoneStatement(['e1', 'e2'])!]);
  assert.deepEqual(db.prepare('SELECT id FROM expenses').all().map((r) => (r as { id: string }).id), ['e2']);
});
