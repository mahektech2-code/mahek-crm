import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../db/schema';
import {
  CUSTOMER_PAGE,
  cityOriginsQuery,
  customerCountQuery,
  customerPageQuery,
} from './customer-query';

/**
 * The book's reads, against a REAL SQLite carrying the REAL schema.
 *
 * `schema.ts` is a list of strings and nothing else — no Expo import anywhere
 * in it — so the migrations this test runs are the migrations a handset runs.
 * That matters more here than anywhere else in the app: the distance ordering
 * binds six repeated parameters into a projection, and whether they land in
 * the right slots is not something anybody can see by reading the string. Bind
 * them wrongly and nothing throws — the book is simply sorted by nonsense, on
 * a phone, in a market, with no console attached.
 */

function handset(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const step of MIGRATIONS) for (const stmt of step) db.exec(stmt);
  return db;
}

/* Real places, so a wrong ordering is obvious rather than arithmetic. */
const MUMBAI = { lat: 19.076, lng: 72.8777 };
const SHOPS: [string, string, number | null, number | null][] = [
  ['c-mumbai', 'Marine Lines Paints', 19.076, 72.8777], //     0 km
  ['c-thane', 'Thane Hardware', 19.2183, 72.9781], //        ~18 km
  ['c-pune', 'Pune Colour House', 18.5204, 73.8567], //     ~120 km
  ['c-nagpur', 'Nagpur Traders', 21.1458, 79.0882], //      ~690 km
  ['c-nowhere', 'Aaaa Unpinned Stores', null, null], //    no fix at all
];

function seed(db: DatabaseSync, rows = SHOPS) {
  const ins = db.prepare(
    `INSERT INTO customers (id, name, city, gpsLat, gpsLng, creditBlocked,
                            outstandingPaise, submittedNotInvoicedPaise,
                            thirdParty, distributors, lastSyncedAt)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, '[]', 1)`,
  );
  for (const [id, name, lat, lng] of rows) {
    ins.run(id, name, name.split(' ')[0], lat, lng);
  }
}

function run(db: DatabaseSync, q: { sql: string; params: (string | number)[] }) {
  return db.prepare(q.sql).all(...q.params) as Record<string, unknown>[];
}

test('nearest first, and a shop with no coordinates still appears — last', () => {
  const db = handset();
  seed(db);

  const rows = run(db, customerPageQuery({ origin: MUMBAI, limit: 10 }));

  assert.deepEqual(
    rows.map((r) => r.id),
    ['c-mumbai', 'c-thane', 'c-pune', 'c-nagpur', 'c-nowhere'],
    'ordered by real distance from Mumbai, with the unpinned shop below the pinned ones',
  );

  /* Alphabetically `Aaaa Unpinned Stores` sorts FIRST, so its position here is
     proof the distance ordering ran rather than the name one falling through. */
  assert.equal(rows[rows.length - 1].id, 'c-nowhere');
  db.close();
});

test('with no origin it is the name, so a handset with no fix still has a book', () => {
  const db = handset();
  seed(db);
  const rows = run(db, customerPageQuery({ limit: 10 }));
  assert.equal(rows[0].id, 'c-nowhere', 'Aaaa… sorts first by name');
  db.close();
});

test('the page is a page, and the count is of what MATCHES', () => {
  const db = handset();
  const many: [string, string, number | null, number | null][] = [];
  for (let i = 0; i < 40; i++) {
    many.push([`c${i}`, `Shop ${String(i).padStart(2, '0')}`, 19 + i / 1000, 72.9]);
  }
  seed(db, many);

  const page = run(db, customerPageQuery({ origin: MUMBAI }));
  assert.equal(page.length, CUSTOMER_PAGE, 'a page is CUSTOMER_PAGE rows, not the book');

  const [{ n }] = run(db, customerCountQuery()) as unknown as [{ n: number }];
  assert.equal(n, 40, 'the total comes from SQL, not from what was loaded');
  db.close();
});

test('paging a book of ties visits every shop exactly once', () => {
  const db = handset();
  /* Every one of them at the SAME coordinates: the distance is identical, so
     ordering is left to the tiebreaker or it is left to the planner — and the
     planner shows one row on two pages and another on none. 37 is chosen not
     to divide the page size, so no page ends on a boundary that would hide the
     fault. */
  const tied: [string, string, number | null, number | null][] = [];
  for (let i = 0; i < 37; i++) tied.push([`t${i}`, 'Identical Stores', 19.1, 72.9]);
  seed(db, tied);

  const seen: string[] = [];
  for (let offset = 0; offset < 37; offset += 5) {
    for (const r of run(db, customerPageQuery({ origin: MUMBAI, limit: 5, offset }))) {
      seen.push(r.id as string);
    }
  }

  assert.equal(seen.length, 37);
  assert.equal(new Set(seen).size, 37, 'every shop exactly once, none twice, none missed');
  db.close();
});

test('search narrows the count as well as the page', () => {
  const db = handset();
  seed(db);

  const page = run(db, customerPageQuery({ query: 'thane', origin: MUMBAI }));
  assert.deepEqual(page.map((r) => r.id), ['c-thane']);

  const [{ n }] = run(db, customerCountQuery('thane')) as unknown as [{ n: number }];
  assert.equal(n, 1, 'the sentence under the list counts matches, not the book');

  /* The city column is searched too, which is how a salesman finds a town. */
  const byCity = run(db, customerPageQuery({ query: 'nagpur' }));
  assert.equal(byCity.length, 1);
  db.close();
});

test('a city is offered as an origin only where the book has pinned a shop in it', () => {
  const db = handset();
  seed(db);

  const cities = run(db, cityOriginsQuery()) as unknown as {
    city: string; n: number; lat: number; lng: number;
  }[];

  const names = cities.map((c) => c.city);
  assert.ok(!names.includes('Aaaa'), 'the unpinned shop’s town cannot be measured from');
  assert.ok(names.includes('Thane'));

  const thane = cities.find((c) => c.city === 'Thane')!;
  assert.ok(Math.abs(thane.lat - 19.2183) < 0.001, 'the centre is the mean of its own shops');
  db.close();
});
