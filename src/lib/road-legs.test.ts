import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_MATRIX_ELEMENTS, batchMatrix, legKey, pairKey } from "./road-legs";

const at = (lat: number, lng: number) => ({ lat, lng });
const elements = (bs: { origins: unknown[]; destinations: unknown[] }[]) =>
  bs.reduce((n, b) => n + b.origins.length * b.destinations.length, 0);

test("the ceiling is the one the live endpoint actually enforces", () => {
  /* Found rather than read off a spec, the same way `snapToRoad`'s batch size
     was: 7x7 (49) answers 200 and 8x8 (64) answers 400, while 1x50, 5x10 and
     2x25 all answer 200 and 1x60, 5x11 (55) and 2x26 (52) all answer 400. It
     caps the PRODUCT, not either side. */
  assert.equal(MAX_MATRIX_ELEMENTS, 50);
});

test("a key rounds to about eleven metres, so a re-plan is not a fresh bill", () => {
  /* A shop does not move; the fix taken in its doorway differs by metres
     between visits. Keying on the raw double would make every re-plan a cache
     miss and every miss a paid request. */
  assert.equal(legKey(at(19.076012, 72.877656)), "19.0760,72.8777");
  assert.equal(legKey(at(19.07604, 72.87766)), "19.0760,72.8777");
  assert.equal(legKey(at(19.076, 72.8777)), legKey(at(19.076, 72.8777)));
});

test("a leg has a direction, because road distance does", () => {
  /* One-ways and divided carriageways: A to B is not always B to A, and a
     cache that treated them as one would quietly report the wrong way round. */
  assert.notEqual(
    pairKey(at(19.1, 72.8), at(19.2, 72.9)),
    pairKey(at(19.2, 72.9), at(19.1, 72.8)),
  );
});

test("no batch ever exceeds what Ola answers", () => {
  for (const [o, d] of [[1, 1], [3, 7], [25, 25], [1, 200], [200, 1], [60, 60]]) {
    for (const b of batchMatrix(
      Array.from({ length: o }, (_, i) => at(19 + i / 1000, 72)),
      Array.from({ length: d }, (_, i) => at(18 + i / 1000, 73)),
    )) {
      assert.ok(
        b.origins.length * b.destinations.length <= MAX_MATRIX_ELEMENTS,
        `${o}x${d} produced a batch of ${b.origins.length * b.destinations.length}`,
      );
    }
  }
});

test("a full day of 25 stops costs thirteen requests, not six hundred", () => {
  /* The figure that decides whether this is affordable. With the destinations
     whole, two origins fit under the ceiling — so the day is 13 requests
     rather than the 25 it costs an origin at a time, or 600 a pair at a time.
     Two salesmen planning 25 days a month is about 650 against 100,000 free. */
  const stops = Array.from({ length: 25 }, (_, i) => at(19.0 + i / 100, 72.0 + i / 100));
  const batches = batchMatrix(stops, stops);
  assert.equal(batches.length, 13);
  /* The diagonal is bought and thrown away, deliberately: excluding it would
     make every row different and a rectangle whose rows differ cannot pack. */
  assert.equal(elements(batches), 25 * 25);
});

test("every wanted leg is asked for exactly once", () => {
  const origins = Array.from({ length: 17 }, (_, i) => at(19 + i / 100, 72));
  const destinations = Array.from({ length: 23 }, (_, i) => at(18 + i / 100, 73));
  const seen = new Set<string>();
  for (const b of batchMatrix(origins, destinations)) {
    for (const o of b.origins) {
      for (const d of b.destinations) {
        const k = pairKey(o, d);
        assert.equal(seen.has(k), false, `${k} asked twice`);
        seen.add(k);
      }
    }
  }
  assert.equal(seen.size, 17 * 23, "a leg is missing from every batch");
});

test("a destination list longer than the ceiling is split, never truncated", () => {
  /* A truncated batch is a leg that silently falls back to straight-line, and
     silently is the entire problem this exists to fix. */
  const origins = [at(19, 72)];
  const destinations = Array.from({ length: 120 }, (_, i) => at(18 + i / 1000, 73));
  const batches = batchMatrix(origins, destinations);
  assert.equal(elements(batches), 120);
  assert.equal(batches.length, 3);
});

test("two fixes eleven metres apart are one place, and paid for once", () => {
  /* Otherwise the rounding does nothing: the cache would hit and the request
     would still have carried both. */
  const stops = [at(19.0, 72.0), at(19.000001, 72.000001), at(19.5, 72.5)];
  const batches = batchMatrix(stops, stops);
  assert.equal(elements(batches), 2 * 2);
});

test("the same rectangle always produces the same batches", () => {
  /* A retry has to ask for the same thing, or a cache fills differently each
     time and the bill is a function of how often somebody pressed the button. */
  const stops = Array.from({ length: 12 }, (_, i) => at(19.0 + i / 100, 72.0));
  assert.deepEqual(batchMatrix(stops, stops), batchMatrix(stops, stops));
});

test("nothing to ask for is no requests at all", () => {
  assert.deepEqual(batchMatrix([], [at(19, 72)]), []);
  assert.deepEqual(batchMatrix([at(19, 72)], []), []);
});
