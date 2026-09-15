import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../db/schema';

/**
 * THE TWO READS OVER `customer_bills`, against a REAL SQLite carrying the REAL
 * schema — the pattern `customer-query.test.ts` established and for its reason:
 * `schema.ts` is a list of strings with no Expo import in it, so the migrations
 * this runs are the migrations a handset runs.
 *
 * What is actually being pinned here is a REVERSAL and the guard that replaced
 * it. The bills channel used to carry open bills and nothing else, so
 * `customerBills` WAS the payment picker's list and there was nothing to
 * filter. It carries settled bills now — a statement made of open bills alone
 * is a year with 10,405 of its 10,815 rows missing — and the picker has to do
 * the filtering the wire used to do. A settled bill offered there is one the
 * salesman names, the server refuses with `bill_settled`, and the refusal
 * reads as the app being broken rather than the phone being stale.
 *
 * The SQL is duplicated here rather than imported because `data/customers.ts`
 * imports the database, which cannot load under `tsx --test`. Any change to
 * either query has to be made in both — which is the same bargain
 * `db/open.test.ts` already strikes, and it is worth it: the alternative is
 * that neither query is checked by anything at all.
 */

function handset(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const step of MIGRATIONS) for (const stmt of step) db.exec(stmt);
  return db;
}

const OPEN_BILLS = `SELECT * FROM customer_bills
   WHERE customerId = ? AND coalesce(balancePaise, 0) > 0
   ORDER BY billDate ASC, id ASC`;

const ALL_BILLS = `SELECT * FROM customer_bills WHERE customerId = ? ORDER BY billDate ASC, id ASC`;

const REACH = `SELECT min(d) AS "from" FROM (
   SELECT billDate AS d FROM customer_bills WHERE customerId = ? AND billDate IS NOT NULL
   UNION ALL
   SELECT receivedAt AS d FROM customer_payments WHERE customerId = ? AND receivedAt IS NOT NULL
 )`;

function bill(
  db: DatabaseSync,
  id: string,
  date: string,
  amount: number,
  balance: number,
  extra: { lines?: string; lineCount?: number; status?: string } = {},
) {
  db.prepare(
    `INSERT INTO customer_bills
       (id, customerId, billNo, billDate, amountPaise, paidPaise, balancePaise,
        disputed, status, lines, lineCount)
     VALUES (?, 'c1', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    id,
    id.toUpperCase(),
    date,
    amount,
    amount - balance,
    balance,
    extra.status ?? 'unpaid',
    extra.lines ?? null,
    extra.lineCount ?? null,
  );
}

test('the payment picker is offered open bills only', () => {
  const db = handset();
  bill(db, 'b-open', '2026-08-01', 250_000, 200_000);
  bill(db, 'b-settled', '2026-07-01', 100_000, 0, { status: 'paid' });

  const offered = db.prepare(OPEN_BILLS).all('c1') as Record<string, unknown>[];
  assert.deepEqual(offered.map((b) => b.id), ['b-open']);

  /* And the statement sees both, which is the whole reason the two reads had
     to be separated rather than one of them being narrowed. */
  const all = db.prepare(ALL_BILLS).all('c1') as Record<string, unknown>[];
  assert.deepEqual(all.map((b) => b.id), ['b-settled', 'b-open']);
});

test('a bill with no balance recorded either way is not offered as one to pay', () => {
  const db = handset();
  db.prepare(
    `INSERT INTO customer_bills (id, customerId, billNo, billDate, amountPaise, balancePaise, disputed)
     VALUES ('b-null', 'c1', 'X', '2026-08-01', 100000, NULL, 0)`,
  ).run();
  const offered = db.prepare(OPEN_BILLS).all('c1') as Record<string, unknown>[];
  assert.equal(offered.length, 0, 'coalesce, or a NULL balance quietly passes a `> 0` test');
});

test('the three statement columns exist on the table a pull writes into', () => {
  const db = handset();
  bill(db, 'b1', '2026-08-01', 100_000, 100_000, {
    status: 'unpaid',
    lines: JSON.stringify([{ product: 'Nano Thinner - 20 Liter (Loose)', qty: 6, amountPaise: 240_000 }]),
    lineCount: 1,
  });
  const [row] = db.prepare(ALL_BILLS).all('c1') as Record<string, unknown>[];
  assert.equal(row.status, 'unpaid');
  assert.equal(row.lineCount, 1);
  assert.equal(
    JSON.parse(String(row.lines))[0].product,
    'Nano Thinner - 20 Liter (Loose)',
    'the lines ride on the bill as TEXT — an object would land as [object Object]',
  );
});

test('how far back this phone reaches is read off the rows, not off the window', () => {
  const db = handset();
  bill(db, 'b1', '2026-06-01', 100_000, 100_000);
  db.prepare(
    `INSERT INTO customer_payments (id, customerId, receivedAt, amountPaise, mode, reference, status)
     VALUES ('r1', 'c1', '2026-04-15', 50000, 'NEFT', 'UTR1', 'confirmed')`,
  ).run();

  const [row] = db.prepare(REACH).all('c1', 'c1') as Record<string, unknown>[];
  assert.equal(
    row.from,
    '2026-04-15',
    'the office may have sent thirteen months; what is HERE is what the screen may claim',
  );
});

test('a shop with nothing on it reaches back to no date at all', () => {
  const db = handset();
  const [row] = db.prepare(REACH).all('c1', 'c1') as Record<string, unknown>[];
  assert.equal(row.from, null, 'null is its own sentence, never a date to print');
});

test('pruning takes the bills and the receipts to the same day', () => {
  const db = handset();
  bill(db, 'b-old', '2025-01-05', 100_000, 100_000);
  bill(db, 'b-new', '2026-08-01', 100_000, 100_000);
  db.prepare(
    `INSERT INTO customer_payments (id, customerId, receivedAt, amountPaise, status)
     VALUES ('r-old', 'c1', '2025-01-06', 5000, 'confirmed'),
            ('r-new', 'c1', '2026-08-02', 5000, 'confirmed')`,
  ).run();

  const from = '2026-08-01';
  db.prepare('DELETE FROM customer_bills WHERE billDate IS NOT NULL AND billDate < ?').run(from);
  db.prepare('DELETE FROM customer_payments WHERE receivedAt IS NOT NULL AND receivedAt < ?').run(from);

  assert.deepEqual(
    (db.prepare(ALL_BILLS).all('c1') as Record<string, unknown>[]).map((b) => b.id),
    ['b-new'],
  );
  assert.deepEqual(
    (db.prepare('SELECT id FROM customer_payments WHERE customerId = ?').all('c1') as Record<string, unknown>[])
      .map((r) => r.id),
    ['r-new'],
    'a statement whose receipts reach further back than its bills opens on a credit ' +
      'paying for an invoice that is not on the screen',
  );
});

test('an undated row survives a prune', () => {
  const db = handset();
  db.prepare(
    `INSERT INTO customer_bills (id, customerId, billNo, billDate, amountPaise, balancePaise, disputed)
     VALUES ('b-undated', 'c1', 'X', NULL, 100000, 100000, 0)`,
  ).run();
  db.prepare('DELETE FROM customer_bills WHERE billDate IS NOT NULL AND billDate < ?').run('2026-08-01');
  assert.equal(
    (db.prepare(ALL_BILLS).all('c1') as Record<string, unknown>[]).length,
    1,
    'a row that cannot be compared is not a row to delete — it is one to show',
  );
});
