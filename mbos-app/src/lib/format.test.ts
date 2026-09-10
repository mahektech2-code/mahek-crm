import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayLabel, dayLabelRelative, inr } from './format';

/*
 * The day's own vocabulary.
 *
 * `dayLabel` lived inside `app/journey.tsx`, so the pick screen one tap away
 * printed the raw `2026-09-09` on the card naming the very day the route
 * screen called `Wed 9 Sep`. It is shared now, which is what makes it worth
 * pinning: two screens read it and a change to either has to keep both right.
 */

test('a calendar day is named the way somebody says it out loud', () => {
  assert.equal(dayLabel('2026-09-09'), 'Wed 9 Sep');
  assert.equal(dayLabel('2026-01-01'), 'Thu 1 Jan');
  assert.equal(dayLabel('2026-12-31'), 'Thu 31 Dec');
});

test('it is built in UTC, so no zone can shift the date', () => {
  /* A local `new Date(2026, 2, 29)` in a zone that springs forward at
     midnight lands on the 28th. These are calendar days with no time in them,
     so there is nothing to convert and nothing to get wrong. */
  assert.equal(dayLabel('2026-03-29'), 'Sun 29 Mar');
  assert.equal(dayLabel('2026-10-25'), 'Sun 25 Oct');
});

test('a date nobody can parse comes back as itself, never as NaN', () => {
  assert.equal(dayLabel(''), '');
  assert.equal(dayLabel('not-a-date'), 'not-a-date');
});

test('the two days anybody acts on are named in words', () => {
  const today = '2026-09-09';
  assert.equal(dayLabelRelative(today, today), 'Today');
  assert.equal(dayLabelRelative('2026-09-10', today), 'Tomorrow');
  assert.equal(dayLabelRelative('2026-09-11', today), 'Fri 11 Sep');
  /* Yesterday is deliberately a date: past days sit under Recently, where one
     relative word among a column of dates reads as a different kind of row. */
  assert.equal(dayLabelRelative('2026-09-08', today), 'Tue 8 Sep');
});

test('tomorrow crosses a month and a year without arithmetic going wrong', () => {
  assert.equal(dayLabelRelative('2026-10-01', '2026-09-30'), 'Tomorrow');
  assert.equal(dayLabelRelative('2027-01-01', '2026-12-31'), 'Tomorrow');
  /* February in a leap year, which a naive +1 on the date string gets wrong. */
  assert.equal(dayLabelRelative('2028-02-29', '2028-02-28'), 'Tomorrow');
  assert.equal(dayLabelRelative('2026-03-01', '2026-02-28'), 'Tomorrow');
});

/*
 * `inr` takes RUPEES, and the pick screen handed it PAISE — so a shop owing
 * ₹2,360 was listed as owing ₹2,36,000 on the row somebody plans a morning
 * from. Pinned here because the mistake is invisible: both are valid figures.
 */
test('rupees are grouped the Indian way', () => {
  assert.equal(inr(2360), '₹2,360');
  assert.equal(inr(236000), '₹2,36,000');
  assert.equal(inr(1243405), '₹12,43,405');
  assert.equal(inr(999), '₹999');
});
