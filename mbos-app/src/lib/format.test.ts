import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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

/* ------------------------------------------------- the unit, read off source */

/**
 * NO `inr(` MAY BE HANDED PAISE, and only the source can be asked.
 *
 * This is the same shape of check as `mbos-wire.test.ts` and
 * `data/reachable.test.ts`, and it exists for the same reason: the defect is
 * invisible to everything else. `inr` takes a `number` and so does
 * `inrFromPaise`, so a call site that hands over paise type-checks perfectly,
 * lints clean, renders without an error and prints a figure that is a hundred
 * times too big — and ₹5,00,000 and ₹5,00,00,000 are both perfectly plausible
 * revenue targets, so nothing on the screen says which one is meant.
 *
 * It went wrong in both directions before this was written. The pick screen
 * handed paise to `inr` and listed a shop owing ₹2,360 as owing ₹2,36,000. The
 * targets screen did it five times over, and the client reported it as "all
 * the amounts in MBOS are showing in paise, so people are getting confused
 * about the targets" — which is exactly what it looks like from the other end.
 *
 * The rule is deliberately crude: an argument that MENTIONS paise may not go to
 * a rupee-taking formatter. It cannot catch a paise value in a variable called
 * `value` or `dues`, and it is not trying to — what it catches is the shape the
 * mistake actually takes, which is a field read straight off a row whose name
 * says what it holds. `inr` stays exported because the rupee callers are real:
 * an amount somebody typed into a box is rupees because that is what he said
 * out loud.
 */
test('no rupee-taking formatter is handed a value whose name says paise', () => {
  const offenders = scanForRupeeFormattersGivenPaise();
  assert.deepEqual(
    offenders,
    [],
    'These hand paise to a formatter that expects rupees — use inrFromPaise / ' +
      'compactInrFromPaise instead:\n  ' + offenders.join('\n  '),
  );
});

test('and the scan would actually catch one, which is the half worth proving', () => {
  /* A guard that cannot fail is a guard nobody can trust. The same reader that
     walks the tree is pointed at one line of the exact code the bug was. */
  assert.deepEqual(
    findRupeeFormattersGivenPaise('x.tsx', 'value={inr(current.revenueTargetPaise)}'),
    ['x.tsx: inr(current.revenueTargetPaise)'],
  );
  assert.deepEqual(
    findRupeeFormattersGivenPaise('x.tsx', 'compactInr(day.collectPaise / 100)'),
    ['x.tsx: compactInr(day.collectPaise / 100)'],
  );
  /* And that it does not cry wolf over the correct spelling, or over a name
     that merely contains the letters. */
  assert.deepEqual(findRupeeFormattersGivenPaise('x.tsx', 'inrFromPaise(x.amountPaise)'), []);
  assert.deepEqual(findRupeeFormattersGivenPaise('x.tsx', 'inr(amountInRupees)'), []);
});

/** Every `inr(`/`compactInr(` call in `src` and `app` whose argument says paise. */
function findRupeeFormattersGivenPaise(file: string, src: string): string[] {
  const found: string[] = [];
  const call = /(?:^|[^A-Za-z0-9_$.])(compactInr|inr)\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(src))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = open;
    for (; close < src.length; close++) {
      if (src[close] === '(') depth++;
      else if (src[close] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const inner = src.slice(open + 1, close);
    if (/paise/i.test(inner)) found.push(`${file}: ${m[1]}(${inner})`);
    call.lastIndex = close;
  }
  return found;
}

function scanForRupeeFormattersGivenPaise(): string[] {
  const root = join(import.meta.dirname, '..', '..');
  const skip = new Set(['node_modules', '.expo', 'android', 'ios', 'dist', 'generated']);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/format\.(ts|test\.ts)$/.test(entry.name)) {
        out.push(...findRupeeFormattersGivenPaise(relative(root, full), readFileSync(full, 'utf8')));
      }
    }
  };
  for (const top of ['app', 'src']) walk(join(root, top));
  return out;
}
