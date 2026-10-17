import test from 'node:test';
import assert from 'node:assert/strict';

import {
  billMatches,
  billStatus,
  creditUse,
  fromPhone,
  longDay,
  matchesText,
  receiptMatches,
  receiptStatus,
  windowOf,
  type AccountBill,
  type AccountEntry,
  type AccountReceipt,
} from './account-view';

/**
 * The Customer accounts screen reads figures the office computed; what the
 * phone does to them is cut windows, filter lists and say statuses in words.
 * Each of those is something a salesman reads out to a shopkeeper, so each is
 * pinned here.
 */

function entry(at: string, kind: 'bill' | 'receipt', debit: number, credit: number, balance: number): AccountEntry {
  return {
    at,
    kind,
    ref: kind === 'bill' ? 'B-' + at : 'UTR-' + at,
    detail: '',
    debitPaise: debit,
    creditPaise: credit,
    status: kind === 'bill' ? 'unpaid' : 'confirmed',
    claimedPaise: 0,
    receiptId: null,
    balancePaise: balance,
  };
}

/* Oldest first, balanced by the office: +1000, +500, -700, +200. */
const LEDGER = [
  entry('2026-04-03', 'bill', 100_000, 0, 100_000),
  entry('2026-05-10', 'bill', 50_000, 0, 150_000),
  entry('2026-06-01', 'receipt', 0, 70_000, 80_000),
  entry('2026-07-15', 'bill', 20_000, 0, 100_000),
];

test('a window keeps the office balance on every line and opens at the line before it', () => {
  const w = windowOf(LEDGER, { from: '2026-05-01', to: '2026-06-30' });
  assert.equal(w.openingPaise, 100_000);
  assert.equal(w.billedPaise, 50_000);
  assert.equal(w.receivedPaise, 70_000);
  /* Newest first, each with the balance it was given — never recomputed. */
  assert.deepEqual(
    w.entries.map((e) => [e.at, e.balancePaise]),
    [
      ['2026-06-01', 80_000],
      ['2026-05-10', 150_000],
    ],
  );
});

test('no window is the whole account, newest first, opening at nothing', () => {
  const w = windowOf(LEDGER, {});
  assert.equal(w.openingPaise, 0);
  assert.equal(w.entries[0].at, '2026-07-15');
  assert.equal(w.entries[0].balancePaise, 100_000);
  assert.equal(w.billedPaise, 170_000);
});

test('an undated line is inside every window rather than lost', () => {
  const w = windowOf([...LEDGER, entry('', 'bill', 1, 0, 100_001)], { from: '2026-07-01' });
  assert.ok(w.entries.some((e) => e.at === ''));
});

function bill(over: Partial<AccountBill>): AccountBill {
  return {
    id: 'b',
    billNo: 'MMI/26-27/1',
    billDate: '2026-04-01',
    dueDate: '2026-05-01',
    amountPaise: 10_000,
    paidPaise: 0,
    balancePaise: 10_000,
    overdueDays: 0,
    bucket: null,
    status: 'unpaid',
    disputed: false,
    paymentPosition: 'stated',
    claimedPaise: 0,
    lines: [],
    payments: [],
    ...over,
  };
}

test('an unstated bill is never open or overdue — it has its own chip', () => {
  const b = bill({ paymentPosition: 'unstated', overdueDays: 40 });
  assert.equal(billMatches(b, 'open'), false);
  assert.equal(billMatches(b, 'overdue'), false);
  assert.equal(billMatches(b, 'unstated'), true);
  assert.equal(billStatus(b).label, 'Not stated');
});

test('a bill says settled, part paid, open or how overdue', () => {
  assert.equal(billStatus(bill({ balancePaise: 0, paidPaise: 10_000 })).label, 'Settled');
  assert.equal(billStatus(bill({ paidPaise: 4_000, balancePaise: 6_000 })).label, 'Part paid');
  assert.equal(billStatus(bill({})).label, 'Open');
  assert.equal(billStatus(bill({ overdueDays: 12 })).label, '12d overdue');
  assert.equal(billMatches(bill({ overdueDays: 12 }), 'overdue'), true);
  assert.equal(billMatches(bill({ balancePaise: 0 }), 'settled'), true);
});

test('only confirmed money counts, and rejected is not reversed', () => {
  assert.equal(receiptStatus('confirmed').counts, true);
  for (const s of ['reported', 'held', 'rejected', 'reversed', null]) {
    assert.equal(receiptStatus(s).counts, false, String(s));
  }
  assert.equal(receiptStatus('rejected').label, 'Never arrived');
  assert.equal(receiptStatus('reversed').label, 'Reversed');
});

test('"With accounts" is the reported ones, and held has its own chip', () => {
  const r = (status: string) => ({ status }) as AccountReceipt;
  assert.equal(receiptMatches(r('reported'), 'waiting'), true);
  assert.equal(receiptMatches(r('held'), 'waiting'), false);
  assert.equal(receiptMatches(r('held'), 'held'), true);
  assert.equal(receiptMatches(r('confirmed'), 'all'), true);
});

test('credit use needs a limit to be a percentage of', () => {
  assert.equal(creditUse(50_000, null), null);
  assert.equal(creditUse(50_000, 0), null);
  assert.equal(creditUse(50_000, 100_000), 50);
  assert.equal(creditUse(150_000, 100_000), 150);
  assert.equal(creditUse(-5_000, 100_000), 0);
});

test('a long day carries its year, and an empty one is a dash', () => {
  assert.equal(longDay('2025-08-24'), '24 Aug 2025');
  assert.equal(longDay('2026-10-02T09:00:00.000Z'), '2 Oct 2026');
  assert.equal(longDay(null), '—');
});

test('search matches any of the fields, case-blind, and nothing matches everything', () => {
  assert.equal(matchesText(['MMI/26-27/1119', 'Thinner'], 'thin'), true);
  assert.equal(matchesText(['MMI/26-27/1119'], '1119'), true);
  assert.equal(matchesText(['MMI/26-27/1119'], 'xyz'), false);
  assert.equal(matchesText([null], ''), true);
});

test("the phone's copy says what it cannot know rather than guessing zero", () => {
  const view = fromPhone(
    {
      id: 'c1',
      name: 'Shree Paints',
      kind: 'customer',
      thirdParty: 0,
      city: 'Nagpur',
      phone: null,
      gstin: null,
      outstandingPaise: 30_000,
      creditLimitPaise: 100_000,
      creditDays: null,
      creditBlocked: 0,
      creditBlockReason: null,
      lastOrderDate: null,
      distributors: null,
      lastSyncedAt: 1,
    },
    [
      {
        id: 'b1',
        billNo: 'B1',
        billDate: '2026-04-01',
        dueDate: null,
        amountPaise: 50_000,
        paidPaise: 20_000,
        balancePaise: 30_000,
        overdueDays: 3,
        disputed: 0,
        paymentPosition: 'stated',
        status: 'partially_paid',
        lineCount: 0,
        lines: null,
      },
    ],
    [
      { id: 'r1', receivedAt: '2026-04-10', amountPaise: 20_000, mode: 'UPI', reference: 'U1', status: 'confirmed' },
      { id: 'r2', receivedAt: '2026-04-12', amountPaise: 5_000, mode: 'Cash', reference: null, status: 'reported' },
    ],
    '2026-10-02',
    () => [],
  );
  assert.equal(view.source, 'phone');
  assert.equal(view.aging, null);
  assert.equal(view.creditNotes, null);
  assert.equal(view.ledger.onAccountPaise, null);
  assert.equal(view.bills[0].payments, null);
  assert.equal(view.receipts[0].allocations, null);
  /* Oldest first, the reported payment moving nothing. */
  assert.deepEqual(
    view.ledger.entries.map((e) => e.balancePaise),
    [50_000, 30_000, 30_000],
  );
  assert.equal(view.ledger.awaitingCount, 1);
  assert.equal(view.ledger.awaitingPaise, 5_000);
  assert.equal(view.receipts[0].id, 'r2', 'newest first');
});
