import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bestPackFor,
  boundsContain,
  boundsWithin,
  boundsOf,
  clusterAreas,
  coverageOf,
  estimateBytes,
  padBounds,
  tileCount,
  type AreaPin,
  type Bounds,
} from './tiles';

/**
 * What these pin down is the two ways an offline map goes wrong in the field.
 *
 * It is too big to download, which the size estimate is there to say BEFORE a
 * salesman starts it on a train; and it does not cover where he actually is,
 * which the coverage count is there to say instead of a blank screen. The
 * clustering sits between the two — it is what stops one salesman's book
 * becoming one four-gigabyte box with a hundred kilometres of farmland in it.
 */

/* Nagpur, roughly, and Amravati — about 150 km apart on the same road. */
const NAGPUR = { lat: 21.1458, lng: 79.0882 };
const AMRAVATI = { lat: 20.9374, lng: 77.7796 };

function pin(id: string, at: { lat: number; lng: number }, over: Partial<AreaPin> = {}): AreaPin {
  return { id, lat: at.lat, lng: at.lng, area: null, city: null, ...over };
}

/** `metres` east and north of a point, near enough for a test at this latitude. */
function near(at: { lat: number; lng: number }, metresEast: number, metresNorth = 0) {
  return {
    lat: at.lat + metresNorth / 110_574,
    lng: at.lng + metresEast / 104_000,
  };
}

/* ------------------------------------------------------------------ boxes */

test('a box round nothing is null, not a box round the origin', () => {
  /* Zero would be a perfectly valid pair of coordinates in the Gulf of Guinea,
     and a pack downloaded there is 300 MB of sea. */
  assert.equal(boundsOf([]), null);
  assert.equal(boundsOf([{ lat: NaN, lng: NaN }]), null);
});

test('padding grows the box on every side', () => {
  const tight = boundsOf([NAGPUR]) as Bounds;
  const padded = padBounds(tight, 2000);

  assert.ok(padded[0] < tight[0], 'west');
  assert.ok(padded[1] < tight[1], 'south');
  assert.ok(padded[2] > tight[2], 'east');
  assert.ok(padded[3] > tight[3], 'north');

  /* Roughly 2 km, in degrees, north-south. */
  assert.ok(Math.abs(padded[3] - tight[3] - 2000 / 110_574) < 1e-6);
});

test('a shop just outside a tight box is inside the padded one', () => {
  /* The whole reason for the margin: a pack has to survive the book growing. */
  const tight = boundsOf([NAGPUR]) as Bounds;
  const padded = padBounds(tight, 1500);
  const newShop = near(NAGPUR, 900, 400);

  assert.equal(boundsContain(tight, newShop), false);
  assert.equal(boundsContain(padded, newShop), true);
});

/* ------------------------------------------------------------------ tiles */

test('one more zoom level is four times the tiles', () => {
  const box = padBounds(boundsOf([NAGPUR]) as Bounds, 10_000);
  const to14 = tileCount(box, 14, 14);
  const to15 = tileCount(box, 15, 15);

  /* Not exactly four — a box straddling a tile edge needs both — so the test
     is that it is close to it rather than that it is it. */
  assert.ok(to15 > to14 * 3, `${to15} should be about four times ${to14}`);
  assert.ok(to15 < to14 * 5);
});

test('the range is the sum of its levels', () => {
  const box = padBounds(boundsOf([NAGPUR]) as Bounds, 5_000);
  const summed = [11, 12, 13, 14].reduce((a, z) => a + tileCount(box, z, z), 0);
  assert.equal(tileCount(box, 11, 14), summed);
});

test('a city-sized box at street zoom is tens of megabytes, not gigabytes', () => {
  /* The estimate exists to answer one question — tens or hundreds — and this
     is the assertion that it is answering it in the right order of magnitude.
     A 20 km box is about a working town. */
  const box = padBounds(boundsOf([NAGPUR, near(NAGPUR, 20_000, 20_000)]) as Bounds, 1_000);
  const megabytes = estimateBytes(tileCount(box, 9, 16), 45_000) / 1e6;

  assert.ok(megabytes > 20, `${megabytes} MB is implausibly small`);
  assert.ok(megabytes < 400, `${megabytes} MB is implausibly large`);
});

test('a corrupt coordinate cannot make the estimate infinite', () => {
  /* One bad latitude past the Mercator limit produced an unbounded tile row,
     which reads on the screen as a download that never ends. */
  const n = tileCount([79, 89.9, 79.1, 90], 10, 14);
  assert.ok(Number.isFinite(n));
});

/* --------------------------------------------------------------- clusters */

test('two towns are two areas, however the book is ordered', () => {
  const pins = [
    pin('n1', NAGPUR, { area: 'Sadar' }),
    pin('a1', AMRAVATI, { area: 'Rajapeth' }),
    pin('n2', near(NAGPUR, 800), { area: 'Sadar' }),
    pin('a2', near(AMRAVATI, 600), { area: 'Rajapeth' }),
  ];

  const areas = clusterAreas(pins, { separationKm: 25 });
  assert.equal(areas.length, 2);
  assert.deepEqual(
    areas.map((a) => a.label).sort(),
    ['Rajapeth', 'Sadar'],
  );
});

test('shops down one street are one area, not one area each', () => {
  const pins = Array.from({ length: 12 }, (_, i) =>
    pin(`s${i}`, near(NAGPUR, i * 300), { area: 'Itwari' }),
  );
  const areas = clusterAreas(pins, { separationKm: 5 });
  assert.equal(areas.length, 1);
  assert.equal(areas[0].shopIds.length, 12);
});

test('a chain of shops joins through its links, not by end-to-end distance', () => {
  /* Single-link is the point. The first and last are 40 km apart, which is
     further than the separation — but every step is short, and a beat that
     runs down a highway is one map, not eight. */
  const pins = Array.from({ length: 9 }, (_, i) =>
    pin(`c${i}`, near(NAGPUR, i * 5_000), { area: 'Kamptee Road' }),
  );
  const areas = clusterAreas(pins, { separationKm: 8 });
  assert.equal(areas.length, 1);
});

test('an area with no name is named for what it is, never left blank', () => {
  const areas = clusterAreas([pin('x', NAGPUR)], { separationKm: 25 });
  assert.equal(areas[0].label, 'Unnamed area');
});

test('the city stands in where nobody filled the area in', () => {
  const areas = clusterAreas([pin('x', NAGPUR, { city: 'Nagpur' })], { separationKm: 25 });
  assert.equal(areas[0].label, 'Nagpur');
});

test('two areas of the same name are told apart by their town', () => {
  const pins = [
    pin('n', NAGPUR, { area: 'Sadar', city: 'Nagpur' }),
    pin('a', AMRAVATI, { area: 'Sadar', city: 'Amravati' }),
  ];
  const labels = clusterAreas(pins, { separationKm: 25 }).map((a) => a.label);
  assert.deepEqual(labels.sort(), ['Sadar · Amravati', 'Sadar · Nagpur']);
});

test('a name that repeats with no town to separate it still gets a distinct row', () => {
  const pins = [pin('n', NAGPUR, { area: 'Sadar' }), pin('a', AMRAVATI, { area: 'Sadar' })];
  const labels = clusterAreas(pins, { separationKm: 25 }).map((a) => a.label);
  assert.equal(new Set(labels).size, 2, `${labels.join(' / ')} are indistinguishable`);
});

test('a label nobody could confuse is left alone', () => {
  /* Qualifying every row would put a town on the one area that never needed
     one, which is noise on the screen the choice is made from. */
  const pins = [
    pin('n', NAGPUR, { area: 'Sadar', city: 'Nagpur' }),
    pin('a', AMRAVATI, { area: 'Rajapeth', city: 'Amravati' }),
  ];
  const labels = clusterAreas(pins, { separationKm: 25 }).map((a) => a.label);
  assert.deepEqual(labels.sort(), ['Rajapeth', 'Sadar']);
});

test('the id survives a shop being added to a town', () => {
  /* If it did not, a pack somebody spent 300 MB on would be orphaned by one
     new shop and offered for download a second time. */
  const before = clusterAreas([pin('a', NAGPUR), pin('b', near(NAGPUR, 400))], {
    separationKm: 25,
  });
  const after = clusterAreas(
    [pin('a', NAGPUR), pin('b', near(NAGPUR, 400)), pin('c', near(NAGPUR, 700, 300))],
    { separationKm: 25 },
  );
  assert.equal(before[0].id, after[0].id);
});

test('the biggest book comes first', () => {
  const pins = [
    pin('a', AMRAVATI, { area: 'Rajapeth' }),
    ...Array.from({ length: 5 }, (_, i) => pin(`n${i}`, near(NAGPUR, i * 200), { area: 'Sadar' })),
  ];
  assert.equal(clusterAreas(pins, { separationKm: 25 })[0].label, 'Sadar');
});

/* -------------------------------------------------------------- coverage */

test('nothing downloaded is none, not partial', () => {
  assert.equal(coverageOf([NAGPUR], []).state, 'none');
});

test('a pack covering some of the book says how many it misses', () => {
  const pack = padBounds(boundsOf([NAGPUR]) as Bounds, 3_000);
  const shops = [NAGPUR, near(NAGPUR, 1_000), AMRAVATI];

  const c = coverageOf(shops, [pack]);
  assert.equal(c.state, 'partial');
  assert.equal(c.inside, 2);
  assert.equal(c.outside, 1);
});

test('two packs together can cover what neither covers alone', () => {
  const packs = [
    padBounds(boundsOf([NAGPUR]) as Bounds, 3_000),
    padBounds(boundsOf([AMRAVATI]) as Bounds, 3_000),
  ];
  assert.equal(coverageOf([NAGPUR, AMRAVATI], packs).state, 'full');
});

test('the best pack for an area is the one holding most of it', () => {
  const wide = padBounds(boundsOf([NAGPUR, AMRAVATI]) as Bounds, 1_000);
  const narrow = padBounds(boundsOf([NAGPUR]) as Bounds, 500);
  const shops = [NAGPUR, AMRAVATI];

  const best = bestPackFor(shops, [{ id: 'narrow', bounds: narrow }, { id: 'wide', bounds: wide }]);
  assert.equal(best?.pack.id, 'wide');
  assert.equal(best?.coverage.state, 'full');
});

test('a pack holding none of an area is not its pack', () => {
  const elsewhere = padBounds(boundsOf([AMRAVATI]) as Bounds, 1_000);
  assert.equal(bestPackFor([NAGPUR], [{ bounds: elsewhere }]), null);
});

/* ----------------------------------------------------------- containment */

test('a box inside another is within it; touching edges count', () => {
  const outer: Bounds = [78, 20, 80, 22];
  assert.equal(boundsWithin([78.5, 20.5, 79.5, 21.5], outer), true);
  assert.equal(boundsWithin(outer, outer), true, 'a box is within itself');
});

test('a box hanging over any edge is not within', () => {
  /* This is what stops "save again" on one town deleting the wide pack that
     was also answering for the next one. */
  const outer: Bounds = [78, 20, 80, 22];
  assert.equal(boundsWithin([77.9, 20.5, 79.5, 21.5], outer), false, 'west');
  assert.equal(boundsWithin([78.5, 19.9, 79.5, 21.5], outer), false, 'south');
  assert.equal(boundsWithin([78.5, 20.5, 80.1, 21.5], outer), false, 'east');
  assert.equal(boundsWithin([78.5, 20.5, 79.5, 22.1], outer), false, 'north');
});
