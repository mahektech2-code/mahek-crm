import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dataSize,
  dayLabel,
  dayLabelRelative,
  distanceLabel,
  hoursInWords,
  inr,
  shopName,
} from './format';

/**
 * Every example here is a real customer name off the production book, or the
 * exact shape of one. That matters: the rule is a compromise, and the only
 * useful question about a compromise is what it does to the data it will
 * actually meet.
 */

test('a shouted name is calmed down', () => {
  assert.equal(shopName('MAULI ENTERPRISES'), 'Mauli Enterprises');
  assert.equal(shopName('AHYAN ELECTRIC & HARDWARE'), 'Ahyan Electric & Hardware');
  assert.equal(shopName('WHOLESALE COLOUR COMPANY'), 'Wholesale Colour Company');
});

test('a whispered one is brought up', () => {
  assert.equal(shopName('jaihind hardware store'), 'Jaihind Hardware Store');
  assert.equal(shopName('r k paints house'), 'R K Paints House');
  assert.equal(shopName('shringi color point'), 'Shringi Color Point');
});

test('a half-typed name is finished, without touching what was deliberate', () => {
  assert.equal(shopName('Vinayak sale'), 'Vinayak Sale');
  assert.equal(shopName('new Asha paint'), 'New Asha Paint');
});

test('an acronym somebody shouted on purpose is left alone', () => {
  /* The rule that earns its keep: without it these become Jsk and P. */
  assert.equal(shopName('JSK Hardware'), 'JSK Hardware');
  assert.equal(shopName('P Janardhan Rao'), 'P Janardhan Rao');
  assert.equal(shopName('3D Traders'), '3D Traders');
});

test('and mixed case inside a word is somebody spelling it that way', () => {
  assert.equal(shopName('McDonald Paints'), 'McDonald Paints');
});

test('separators keep their shape', () => {
  /* Splitting on them and rejoining is how M/S becomes M / S. */
  assert.equal(shopName('M/S GUPTA TRADERS'), 'M/S Gupta Traders');
  assert.equal(shopName('r.k. enterprises'), 'R.K. Enterprises');
  assert.equal(shopName('  SHAH   AND  SONS '), 'Shah   And  Sons');
});

test('what it cannot do, stated rather than pretended', () => {
  /* Inside an all-capitals name nothing distinguishes the acronym from the
     rest, so this one is wrong and knowingly so. */
  assert.equal(shopName('JSK HARDWARE'), 'Jsk Hardware');
});

test('nothing in, nothing out', () => {
  assert.equal(shopName(''), '');
  assert.equal(shopName(null), '');
  assert.equal(shopName(undefined), '');
});

test('distance is said the way somebody walking would say it', () => {
  assert.equal(distanceLabel(0), '10 m', 'never claims to be standing on it');
  assert.equal(distanceLabel(83), '80 m', 'rounded to ten — the fix is not better than that');
  assert.equal(distanceLabel(940), '940 m');
  assert.equal(distanceLabel(1200), '1.2 km');
  assert.equal(distanceLabel(9949), '9.9 km');
  assert.equal(distanceLabel(14200), '14 km', 'a tenth of a km means nothing at this range');
});

test('no fix, no figure', () => {
  assert.equal(distanceLabel(null), null);
  assert.equal(distanceLabel(undefined), null);
  assert.equal(distanceLabel(Number.NaN), null);
  assert.equal(distanceLabel(-5), null);
});


/* ------------------------------------------------------- the day's own words
 *
 * `dayLabel` lived inside `app/journey.tsx`, so the pick screen one tap away
 * printed the raw `2026-09-09` on the card naming the very day the route
 * screen called `Wed 9 Sep`. It is shared now, which is what makes it worth
 * pinning: two screens read it, and a change to either has to keep both right.
 */

test('a calendar day is named the way somebody says it out loud', () => {
  assert.equal(dayLabel('2026-09-09'), 'Wed 9 Sep');
  assert.equal(dayLabel('2026-01-01'), 'Thu 1 Jan');
  assert.equal(dayLabel('2026-12-31'), 'Thu 31 Dec');
});

test('it is built in UTC, so no zone can shift the date', () => {
  /* A local `new Date(2026, 2, 29)` in a zone that springs forward at midnight
     lands on the 28th. These are calendar days with no time of day in them, so
     there is nothing to convert and nothing to get wrong. */
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

test('tomorrow crosses a month and a year without the arithmetic going wrong', () => {
  assert.equal(dayLabelRelative('2026-10-01', '2026-09-30'), 'Tomorrow');
  assert.equal(dayLabelRelative('2027-01-01', '2026-12-31'), 'Tomorrow');
  /* February in a leap year, which a naive +1 on the date string gets wrong. */
  assert.equal(dayLabelRelative('2028-02-29', '2028-02-28'), 'Tomorrow');
  assert.equal(dayLabelRelative('2026-03-01', '2026-02-28'), 'Tomorrow');
});

/*
 * `inr` takes RUPEES, and the pick screen handed it PAISE — so a shop owing
 * ₹2,360 was listed as owing ₹2,36,000 on the row somebody plans a morning
 * from. Pinned because the mistake is invisible: both are valid figures.
 */
test('rupees are grouped the Indian way', () => {
  assert.equal(inr(2360), '₹2,360');
  assert.equal(inr(236000), '₹2,36,000');
  assert.equal(inr(1243405), '₹12,43,405');
  assert.equal(inr(999), '₹999');
});

/* ------------------------------------------------------------- data size */

test('a download is said in the unit the decision is made in', () => {
  assert.equal(dataSize(314_572_800), '315 MB');
  assert.equal(dataSize(1_400_000_000), '1.4 GB');
  assert.equal(dataSize(45_000), '45 KB');
});

test('a size nobody could work out reads as an em dash, never as zero', () => {
  /* A pack whose status will not load has no size. Printing "0 MB" against it
     would read as an empty download rather than an unreadable one. */
  assert.equal(dataSize(null), '—');
  assert.equal(dataSize(undefined), '—');
  assert.equal(dataSize(NaN), '—');
});

/* --------------------------------------------------------- a span of hours */

test('a retention window is said in days where it is whole days', () => {
  /* This is read by the salesman being photographed, so it has to be the
     sentence he would say, not the number the office typed. */
  assert.equal(hoursInWords(72), '3 days');
  assert.equal(hoursInWords(24), '24 hours');
  assert.equal(hoursInWords(168), '7 days');
});

test('and stays in hours where it is not, rather than rounding to a lie', () => {
  /* 36 hours is not "2 days", and being approximate about how long somebody's
     photograph is kept is exactly the wrong place to be approximate. */
  assert.equal(hoursInWords(36), '36 hours');
  assert.equal(hoursInWords(1), '1 hour');
});

test('a nonsense window says nothing rather than something confident', () => {
  assert.equal(hoursInWords(0), '0 hours');
  assert.equal(hoursInWords(NaN), '0 hours');
});
