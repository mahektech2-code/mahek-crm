import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../db/schema';
import {
  CUSTOMER_PAGE,
  customerCountQuery,
  customerFilterCountsQuery,
  customerPageQuery,
} from './customer-query';
import { LEAD_PAGE, leadBookQuery, leadCountQuery } from './lead-query';

/**
 * THE BOOK AT THE SIZE IT ACTUALLY IS.
 *
 * Every other test here seeds five shops, which is how a list survives that
 * cannot survive ten thousand. This one seeds a real territory's worth and
 * asks the two things that matter at that size: that each chip catches what
 * its name says — the SAME rows the count says — and that paging walks the
 * whole book once, with nothing twice and nothing missed.
 */

const TODAY = '2026-10-03';
const N = 10_000;

function handset(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const step of MIGRATIONS) for (const stmt of step) db.exec(stmt);
  const ins = db.prepare(
    `INSERT INTO customers (id, name, city, gpsLat, gpsLng, creditBlocked, outstandingPaise,
       submittedNotInvoicedPaise, thirdParty, distributors, lastSyncedAt,
       lastOrderDate, cycleDays, lastVisitDate, visitFrequencyDays)
     VALUES (?, ?, ?, ?, ?, 0, ?, 0, 0, '[]', 1, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  for (let i = 0; i < N; i++) {
    const pinned = i % 3 !== 0;
    ins.run(
      `c${i}`,
      /* Deliberately repeated names: a page boundary inside a tie is where a
         broken ordering shows one shop twice and another not at all. */
      `Shop ${i % 400}`,
      i % 2 ? 'Nagpur' : 'Wardha',
      pinned ? 21 + (i % 100) / 1000 : null,
      pinned ? 79 + (i % 97) / 1000 : null,
      i % 5 === 0 ? 100_000 * (i % 7) : 0,
      i % 4 === 0 ? null : '2026-09-01',
      i % 4 === 0 ? null : i % 2 ? 20 : 60,
      i % 6 === 0 ? null : '2026-09-20',
      i % 8 === 0 ? 7 : null,
    );
  }
  db.exec('COMMIT');
  /* Every tenth shop is also a lead, so the customers half must leave it out. */
  db.exec(`INSERT INTO leads (id, name, stage, archived, clientCreatedAt, deviceId)
           SELECT id, name, 'New', 0, 1, 'test' FROM customers WHERE CAST(substr(id, 2) AS INTEGER) % 10 = 0`);
  return db;
}

function count(db: DatabaseSync, q: { sql: string; params: (string | number)[] }): number {
  return (db.prepare(q.sql).get(...q.params) as { n: number }).n;
}

test('every chip counts exactly the rows it shows', () => {
  const db = handset();
  const counts = db
    .prepare(customerFilterCountsQuery(undefined, 'customers', TODAY).sql)
    .get(...customerFilterCountsQuery(undefined, 'customers', TODAY).params) as Record<string, number>;
  for (const filter of ['owing', 'reorder', 'visitDue', 'neverVisited', 'unpinned'] as const) {
    const n = count(db, customerCountQuery(undefined, 'customers', filter, TODAY));
    assert.equal(counts[filter], n, `${filter}: the chip says ${counts[filter]}, the list holds ${n}`);
    assert.ok(n > 0 && n < counts.all, `${filter} should narrow the book (${n} of ${counts.all})`);
  }
  assert.equal(counts.all, N - N / 10, 'the customer half leaves the leads out');
});

test('reorder due is the same rule the row uses — measured cycle, past it', () => {
  const db = handset();
  const q = customerPageQuery({ view: 'customers', filter: 'reorder', today: TODAY, limit: 500, sort: 'name' });
  const rows = db.prepare(q.sql).all(...q.params) as { cycleDays: number; lastOrderDate: string }[];
  /* 32 days since 1 Sep: the 20-day buyers are due, the 60-day buyers are not. */
  assert.ok(rows.length > 0);
  for (const r of rows) assert.equal(r.cycleDays, 20);
});

for (const sort of ['near', 'name', 'owed', 'unseen'] as const) {
  test(`paging by ${sort} walks the whole book once`, () => {
    const db = handset();
    const total = count(db, customerCountQuery(undefined, 'customers'));
    const seen = new Set<string>();
    for (let offset = 0; offset < total; offset += CUSTOMER_PAGE) {
      const q = customerPageQuery({
        view: 'customers',
        sort,
        origin: { lat: 21.05, lng: 79.05 },
        offset,
      });
      for (const r of db.prepare(q.sql).all(...q.params) as { id: string }[]) {
        assert.ok(!seen.has(r.id), `${r.id} came back twice`);
        seen.add(r.id);
      }
    }
    assert.equal(seen.size, total);
  });
}

test('a page of ten thousand is quick enough to page on a phone', () => {
  const db = handset();
  /* A laptop is several times a budget phone, so the bar is set well under
     what a person would notice even scaled up. */
  for (const sort of ['near', 'name', 'owed'] as const) {
    const q = customerPageQuery({ view: 'customers', sort, origin: { lat: 21.05, lng: 79.05 }, offset: 3000 });
    const t = performance.now();
    db.prepare(q.sql).all(...q.params);
    const ms = performance.now() - t;
    assert.ok(ms < 60, `${sort}: ${ms.toFixed(1)}ms for one page`);
  }
});

test('the lead book pages and counts what it pages', () => {
  const db = handset();
  const total = count(db, leadCountQuery({ today: TODAY }));
  assert.equal(total, N / 10);
  const seen = new Set<string>();
  for (let offset = 0; offset < total; offset += LEAD_PAGE) {
    const q = leadBookQuery({ today: TODAY }, '', { limit: LEAD_PAGE, offset });
    const rows = db.prepare(q.sql).all(...q.params) as { id: string }[];
    assert.ok(rows.length <= LEAD_PAGE);
    for (const r of rows) {
      assert.ok(!seen.has(r.id), `${r.id} came back twice`);
      seen.add(r.id);
    }
  }
  assert.equal(seen.size, total);
});
