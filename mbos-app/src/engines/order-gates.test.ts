import test from 'node:test';
import assert from 'node:assert/strict';
import { minimumRefusal, officeCreditRefusal, oldestOverdue, overdueRefusal } from './order-gates';

const credit = { blockOnLimitExceeded: true, billerName: 'Om Traders', creditLimitPaise: 100_000, outstandingPaise: 80_000 };

test('over the limit with the switch on is refused, as the office refuses it', () => {
  const r = officeCreditRefusal({ ...credit, orderValuePaise: 30_000 });
  assert.equal(r?.code, 'credit_exceeded');
  assert.match(r!.reason, /will not accept/);
  assert.match(r!.reason, /Om Traders/);
});

test('inside the limit, switch off, no limit, or no value is taken', () => {
  assert.equal(officeCreditRefusal({ ...credit, orderValuePaise: 20_000 }), null, 'exactly at the limit');
  assert.equal(officeCreditRefusal({ ...credit, blockOnLimitExceeded: false, orderValuePaise: 30_000 }), null);
  assert.equal(officeCreditRefusal({ ...credit, creditLimitPaise: null, orderValuePaise: 30_000 }), null);
  assert.equal(officeCreditRefusal({ ...credit, orderValuePaise: null }), null);
});

test('an edit is refused only where it raises the value', () => {
  assert.equal(officeCreditRefusal({ ...credit, orderValuePaise: 30_000, previousValuePaise: 40_000 }), null);
  assert.equal(officeCreditRefusal({ ...credit, orderValuePaise: 30_000, previousValuePaise: 25_000 })?.code, 'credit_exceeded');
});

test('the overdue rule counts days from the due date to today, and leaves unstated and disputed bills out', () => {
  const bills = [
    { billNo: 'A', dueDate: '2026-08-01', balancePaise: 100 },
    { billNo: 'B', dueDate: '2026-06-01', balancePaise: 100, paymentPosition: 'unstated' },
    { billNo: 'C', dueDate: '2026-05-01', balancePaise: 100, disputed: 1 },
    { billNo: 'D', dueDate: '2026-01-01', balancePaise: 0 },
  ];
  assert.deepEqual(oldestOverdue(bills, '2026-11-26'), { days: 117, billNo: 'A' });
  assert.equal(overdueRefusal({ blockDays: 90, billerName: 'X', bills, today: '2026-11-26' })?.code, 'overdue_blocked');
  assert.equal(overdueRefusal({ blockDays: 120, billerName: 'X', bills, today: '2026-11-26' }), null);
  assert.equal(overdueRefusal({ blockDays: 0, billerName: 'X', bills, today: '2026-11-26' }), null, '0 is off');
});

test('the minimum is per line and 0 is none', () => {
  const lines = [{ productName: 'Nano Thinner 5 L', cans: 2 }, { productName: 'Primer 20 L', cans: 12 }];
  assert.equal(minimumRefusal({ minimumCans: 0, lines }), null);
  assert.match(minimumRefusal({ minimumCans: 6, lines })!.reason, /Nano Thinner/);
  assert.equal(minimumRefusal({ minimumCans: 2, lines }), null);
});
