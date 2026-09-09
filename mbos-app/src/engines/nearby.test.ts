import test from 'node:test';
import assert from 'node:assert/strict';

import { nearby, nextBestVisit, type NearbyInput } from './nearby';

/**
 * "The nearest customer should not automatically be the highest priority."
 *
 * The brief says it in as many words, and these tests are what stop the obvious
 * implementation — sort by distance — creeping back in. Distance is a COST here
 * and the thing it is weighed against is whether there is anything to say when
 * you get there.
 */

const HERE = { lat: 21.1458, lng: 79.0882 };
const TODAY = '2026-09-09';

/** A shop `metresEast` away, with nothing interesting about it. */
function shop(id: string, metresEast: number, over: Partial<NearbyInput> = {}): NearbyInput {
  /* Roughly 104 m per 0.001° of longitude at this latitude. Close enough: the
     tests turn on ordering, not on surveying. */
  return {
    id,
    name: id,
    coords: { lat: HERE.lat, lng: HERE.lng + metresEast / 104_000 },
    outstandingPaise: 0,
    lastOrderDate: null,
    cycleDays: null,
    lastVisitDate: '2026-09-01',
    leadStage: null,
    hasOpenTask: false,
    ...over,
  };
}

const OPTS = { radiusMetres: 5000, today: TODAY };

test('a far shop with a reason beats a near one without', () => {
  /* The whole thesis. 3 km away with a task waiting outranks 100 m away with
     nothing to say — and the naive "sort by distance" gets this backwards. */
  const results = nearby(HERE, [
    shop('near-and-pointless', 100),
    shop('far-but-needed', 3000, { hasOpenTask: true }),
  ], OPTS);

  assert.equal(results[0]?.shop.id, 'far-but-needed');
});

test('a shop with nothing to say is not in the list at all', () => {
  /* "Nearby" is a list of what to DO, not of everything within the radius.
     Somebody who wants the whole book has the customer list. */
  const results = nearby(HERE, [shop('quiet', 50)], OPTS);
  assert.deepEqual(results, []);
});

test('distance still decides between two equal reasons', () => {
  /* The one place proximity legitimately wins: same reason, so go to the near
     one first. */
  const results = nearby(HERE, [
    shop('far', 2000, { hasOpenTask: true }),
    shop('near', 200, { hasOpenTask: true }),
  ], OPTS);

  assert.equal(results[0]?.shop.id, 'near');
});

test('outside the radius is outside, however good the reason', () => {
  const results = nearby(HERE, [shop('miles-away', 9000, { hasOpenTask: true })], {
    ...OPTS,
    radiusMetres: 3000,
  });
  assert.deepEqual(results, []);
});

test('a shop with no coordinate is dropped rather than guessed at', () => {
  /* Unlike the ROUTE engine, which appends a coordinate-less stop and flags it.
     The difference is what the answer is for: a day's route must not silently
     lose a stop, and "what is near me" cannot honestly include a shop whose
     position nobody knows. */
  const results = nearby(HERE, [
    { ...shop('no-pin', 100, { hasOpenTask: true }), coords: null },
  ], OPTS);
  assert.deepEqual(results, []);
});

test('a settled lead is not a reason to knock', () => {
  /* Won, lost and on hold are settled. Turning up is a wasted stop. */
  for (const stage of ['won', 'lost', 'on_hold']) {
    assert.deepEqual(nearby(HERE, [shop('settled', 100, { leadStage: stage })], OPTS), []);
  }
  /* One still being worked is worth a knock. */
  assert.equal(nearby(HERE, [shop('live', 100, { leadStage: 'contacted' })], OPTS).length, 1);
});

test('reasons stack, and the list says all of them', () => {
  /* A shop that owes money AND is overdue to reorder is a better stop than one
     that only does the first, and the card has to say why rather than showing a
     number nobody can get behind. */
  const both = nearby(HERE, [
    shop('one-reason', 100, { outstandingPaise: 50_000 }),
    shop('two-reasons', 100, {
      outstandingPaise: 50_000,
      lastOrderDate: '2026-06-01',
      cycleDays: 30,
    }),
  ], OPTS);

  assert.equal(both[0]?.shop.id, 'two-reasons');
  assert.ok(both[0].reasons.length >= 2, both[0].reasons.join(', '));
  assert.ok(both[0].reasons.includes('Money outstanding'));
});

test('a trivial debt is not a reason to make a detour', () => {
  /* Below the floor it does not count. Chasing ₹40 in person costs more than
     it recovers, and a list that says so about every shop is a list nobody
     reads. */
  assert.deepEqual(nearby(HERE, [shop('pennies', 100, { outstandingPaise: 4_000 })], OPTS), []);
});

test('Next Best Visit is the head of the same list, not a second sum', () => {
  /* If these were two calculations the button and the list could recommend
     different shops, which is the kind of disagreement that makes somebody stop
     trusting both. */
  const shops = [
    shop('a', 400, { outstandingPaise: 90_000 }),
    shop('b', 1500, { hasOpenTask: true }),
    shop('c', 90),
  ];
  assert.equal(nextBestVisit(HERE, shops, OPTS)?.shop.id, nearby(HERE, shops, OPTS)[0].shop.id);
});

test('nothing worth stopping at answers null rather than the closest thing', () => {
  assert.equal(nextBestVisit(HERE, [shop('quiet', 50)], OPTS), null);
});
