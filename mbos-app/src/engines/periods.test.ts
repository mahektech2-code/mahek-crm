import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customPeriod, periodFor, rangeWords, wholeMonth } from './periods';

const range = (key: Parameters<typeof periodFor>[0], today: string) => {
  const p = periodFor(key, today);
  return `${p.from}..${p.to}`;
};

test('a month is the calendar month, and last month crosses the year', () => {
  assert.equal(range('this-month', '2026-10-02'), '2026-10-01..2026-10-31');
  assert.equal(range('last-month', '2026-10-02'), '2026-09-01..2026-09-30');
  assert.equal(range('last-month', '2027-01-15'), '2026-12-01..2026-12-31');
  assert.equal(range('last-month', '2028-03-31'), '2028-02-01..2028-02-29');
});

test('a year is the financial year, April to March', () => {
  assert.equal(range('this-year', '2026-10-02'), '2026-04-01..2027-03-31');
  assert.equal(range('this-year', '2027-02-10'), '2026-04-01..2027-03-31');
  assert.equal(range('this-year', '2027-04-01'), '2027-04-01..2028-03-31');
  assert.equal(range('last-year', '2026-10-02'), '2025-04-01..2026-03-31');
});

test('quarters follow the financial year', () => {
  assert.equal(range('this-quarter', '2026-04-01'), '2026-04-01..2026-06-30');
  assert.equal(range('this-quarter', '2026-10-02'), '2026-10-01..2026-12-31');
  assert.equal(range('this-quarter', '2027-02-28'), '2027-01-01..2027-03-31');
  assert.equal(range('last-quarter', '2027-01-05'), '2026-10-01..2026-12-31');
  assert.equal(range('last-quarter', '2026-05-20'), '2026-01-01..2026-03-31');
});

test('a custom range is put in order whichever end was picked first', () => {
  const p = customPeriod('2026-09-20', '2026-09-03');
  assert.equal(`${p.from}..${p.to}`, '2026-09-03..2026-09-20');
});

test('only an exact calendar month is a month the sync carries', () => {
  assert.equal(wholeMonth({ from: '2026-09-01', to: '2026-09-30' }), '2026-09');
  assert.equal(wholeMonth({ from: '2026-09-01', to: '2026-09-29' }), null);
  assert.equal(wholeMonth({ from: '2026-09-02', to: '2026-09-30' }), null);
  assert.equal(wholeMonth({ from: '2026-09-01', to: '2026-10-31' }), null);
});

test('the dates are said in words', () => {
  assert.equal(rangeWords({ from: '2026-09-01', to: '2026-09-30' }), 'Sep 2026');
  assert.equal(rangeWords({ from: '2026-04-01', to: '2027-03-31' }), '1 Apr 2026 – 31 Mar 2027');
  assert.equal(rangeWords({ from: '2026-09-03', to: '2026-09-20' }), '3 Sep – 20 Sep 2026');
  assert.equal(rangeWords({ from: '2026-09-03', to: '2026-09-03' }), '3 Sep 2026');
});
