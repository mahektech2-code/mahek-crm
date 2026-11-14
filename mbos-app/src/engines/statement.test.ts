import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStatement,
  countsAsMoney,
  periodRange,
  type StatementBill,
  type StatementReceipt,
} from './statement';

/**
 * The arithmetic a salesman reads out to a shopkeeper with a file open in
 * front of him. It is worth pinning down to the rupee, and none of it could be
 * exercised while it lived in a file that imports the database.
 */

function bill(id: string, date: string | null, amountPaise: number, over: Partial<StatementBill> = {}): StatementBill {
  return {
    id,
    billNo: id.toUpperCase(),
    billDate: date,
    dueDate: null,
    amountPaise,
    paidPaise: 0,
    balancePaise: amountPaise,
    overdueDays: 0,
    disputed: 0,
    paymentPosition: 'stated',
    status: 'unpaid',
    lineCount: 2,
    ...over,
  };
}

function receipt(id: string, date: string, amountPaise: number, status = 'confirmed'): StatementReceipt {
  return { id, receivedAt: date, amountPaise, mode: 'NEFT', reference: 'UTR' + id, status };
}

test('only confirmed money counts', () => {
  assert.equal(countsAsMoney('confirmed'), true);
  for (const s of ['reported', 'held', 'rejected', 'reversed', null, undefined, 'anything_new']) {
    assert.equal(countsAsMoney(s), false, String(s));
  }
});

test('the running balance is what was left after each line', () => {
  const s = buildStatement(
    [bill('b1', '2026-07-01', 100_000), bill('b2', '2026-08-01', 50_000)],
    [receipt('r1', '2026-07-20', 60_000)],
  );
  /* Newest first on screen: bill 2, then the receipt, then bill 1. */
  assert.deepEqual(
    s.entries.map((e) => [e.at, e.balancePaise]),
    [
      ['2026-08-01', 90_000],
      ['2026-07-20', 40_000],
      ['2026-07-01', 100_000],
    ],
  );
  assert.equal(s.billedPaise, 150_000);
  assert.equal(s.receivedPaise, 60_000);
});

test('a reported receipt is shown, counted nowhere, and said out loud', () => {
  const s = buildStatement(
    [bill('b1', '2026-07-01', 100_000)],
    [receipt('r1', '2026-07-20', 60_000, 'reported')],
  );
  assert.equal(s.entries.length, 2, 'the claim is on the statement');
  assert.equal(s.receivedPaise, 0, 'and has moved nothing');
  assert.equal(s.entries[0].balancePaise, 100_000);
  assert.equal(s.awaitingPaise, 60_000);
  assert.equal(s.awaitingCount, 1);
});

test('a rejected receipt is on the statement and is not awaiting anything', () => {
  const s = buildStatement([], [receipt('r1', '2026-07-20', 60_000, 'rejected')]);
  assert.equal(s.entries.length, 1);
  assert.equal(s.receivedPaise, 0);
  assert.equal(s.awaitingCount, 0, 'accounts looked and never found it — nobody is waiting');
});

test('a window opens on what was already owed', () => {
  const s = buildStatement(
    [bill('b1', '2026-03-01', 100_000), bill('b2', '2026-08-01', 50_000)],
    [receipt('r1', '2026-03-20', 20_000)],
    { from: '2026-04-01' },
  );
  assert.equal(s.openingPaise, 80_000, 'last year, carried in');
  assert.equal(s.entries.length, 1);
  assert.equal(s.entries[0].balancePaise, 130_000, 'the balance never restarts at the window');
  assert.equal(s.billedPaise, 50_000, 'but the totals describe the window');
});

test('a bill raised and settled the same day reads in that order', () => {
  const s = buildStatement(
    [bill('b1', '2026-07-01', 100_000)],
    [receipt('r1', '2026-07-01', 100_000)],
  );
  /* Reversed for reading, so the receipt is on top and the bill beneath it. */
  assert.equal(s.entries[0].kind, 'receipt');
  assert.equal(s.entries[1].kind, 'bill');
  assert.equal(s.entries[1].balancePaise, 100_000, 'owed');
  assert.equal(s.entries[0].balancePaise, 0, 'then paid');
});

test('a bill with no date is kept, and sorts last', () => {
  const s = buildStatement([bill('b1', '2026-07-01', 100_000), bill('b2', null, 5_000)], []);
  assert.equal(s.entries.length, 2);
  /* Last in computation order, so first once the list is reversed for reading. */
  const top = s.entries[0];
  assert.equal(top.kind, 'bill');
  assert.equal(top.kind === 'bill' ? top.bill.id : null, 'b2');
});

test('an undated row is inside every window', () => {
  const s = buildStatement([bill('b1', null, 5_000)], [], { from: '2026-04-01', to: '2026-04-30' });
  assert.equal(s.entries.length, 1, 'never hidden by a filter it cannot be compared against');
});

/* ------------------------------------------------------------- the periods */

test('this month runs from the first to today', () => {
  assert.deepEqual(periodRange('this_month', '2026-09-13'), { from: '2026-09-01', to: '2026-09-13' });
});

test('last month is the whole of it, not the same span ending today', () => {
  assert.deepEqual(periodRange('last_month', '2026-09-13'), { from: '2026-08-01', to: '2026-08-31' });
});

test('last month across a year boundary', () => {
  assert.deepEqual(periodRange('last_month', '2027-01-09'), { from: '2026-12-01', to: '2026-12-31' });
});

test('last month lands on the real last day of a short one', () => {
  assert.deepEqual(periodRange('last_month', '2026-03-05'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(periodRange('last_month', '2024-03-05'), { from: '2024-02-01', to: '2024-02-29' });
});

test('three months is two whole ones plus this one to date', () => {
  assert.deepEqual(periodRange('three_months', '2026-09-13'), { from: '2026-07-01', to: '2026-09-13' });
});

test('this year is the FINANCIAL year, which is what the bill number says', () => {
  assert.deepEqual(periodRange('this_year', '2026-09-13'), { from: '2026-04-01', to: '2026-09-13' });
  /* Before April, the year that started last April — not three days of it. */
  assert.deepEqual(periodRange('this_year', '2027-02-02'), { from: '2026-04-01', to: '2027-02-02' });
  assert.deepEqual(periodRange('this_year', '2026-04-01'), { from: '2026-04-01', to: '2026-04-01' });
});

test('everything here has no bounds of its own', () => {
  assert.deepEqual(periodRange('all', '2026-09-13'), {});
});
