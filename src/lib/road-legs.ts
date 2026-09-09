/**
 * Asking Ola Maps for road distances, arranged so it can be asked cheaply —
 * PURE, no I/O, no key, no network.
 *
 * The route engine is straight-line by design and says so: the phone is
 * offline in a market lane and a route that arrives beats one that is optimal.
 * That reasoning holds for ORDERING the stops and fails completely for
 * BUDGETING the day. A city beat's roads are not straight: Mumbai to Pune is
 * 141 km by road and about 120 in a straight line, and inside a beat the gap
 * is proportionally worse because every lane bends. A day planned on
 * straight-line minutes is a day that runs out of hours.
 *
 * So road figures are fetched by the SERVER, which has a connection, and the
 * handset uses them where they arrived and its own straight-line answer where
 * they did not. Nothing on the phone ever waits on Ola.
 *
 * THE CEILING IS 50 ELEMENTS, origins × destinations, and it was found rather
 * than read off a spec — the same way `snapToRoad`'s 50-point batch was, and
 * it is the same 50. Measured against the live endpoint: 7×7 (49) answers 200
 * and 8×8 (64) answers 400; 1×50, 5×10 and 2×25 all answer 200 while 1×60,
 * 5×11 (55) and 2×26 (52) all answer 400. It is a cap on the PRODUCT, not on
 * either side, which is what lets a long thin batch carry 50 pairs in one
 * request where a square one carries 49.
 */

/** Ola Maps answers a distance matrix of at most this many origin×destination pairs. */
export const MAX_MATRIX_ELEMENTS = 50;

export type LatLng = { lat: number; lng: number };

/**
 * A coordinate as a cache key, rounded to about eleven metres.
 *
 * Four decimal places. A shop does not move, but the fix taken standing in its
 * doorway differs by a few metres between visits, and keying on the raw double
 * would make every re-plan a cache miss and every miss a paid request. Eleven
 * metres is inside the accuracy of the handset fixes themselves — `gps_accuracy_m`
 * is routinely 6 to 900 — so it cannot lose a distinction the data carries.
 *
 * Fixed notation, so 19.076 and 19.0760 are one key rather than two.
 */
export function legKey(p: LatLng): string {
  return `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
}

/** One direction of one pair. Road distance is not symmetric — one-ways exist. */
export function pairKey(from: LatLng, to: LatLng): string {
  return `${legKey(from)}>${legKey(to)}`;
}

export type MatrixBatch = { origins: LatLng[]; destinations: LatLng[] };

/**
 * A rectangle of wanted legs, cut into requests Ola will actually answer.
 *
 * The RECTANGLE is the primitive, not a list of pairs, because that is the
 * shape the endpoint takes and the shape that makes a request carry its
 * weight. One origin against twenty destinations is twenty elements in one
 * request; asked pair by pair it is twenty requests for the same answer.
 *
 * Origins are packed as tightly as the destination chunk allows. A day of 25
 * stops is 25 origins by 25 destinations: with the destinations whole, two
 * origins fit under the ceiling of 50, so the day costs 13 requests rather
 * than the 25 it would cost an origin at a time — and 600 it would cost a pair
 * at a time. Two salesmen planning 25 days a month is about 650 requests
 * against a free tier of 100,000.
 *
 * The diagonal is deliberately NOT removed here. A stop to itself is zero and
 * the caller drops it; excluding it would make every origin's destination list
 * different, and a rectangle whose rows differ cannot be packed at all — which
 * is the whole saving. Spending 25 elements on a diagonal to save 12 requests
 * is the right way round when the free tier counts requests.
 *
 * Deterministic in and out: the same rectangle produces the same batches, so a
 * retry asks for the same thing and a cache fills the same way.
 */
export function batchMatrix(
  origins: readonly LatLng[],
  destinations: readonly LatLng[],
  maxElements = MAX_MATRIX_ELEMENTS,
): MatrixBatch[] {
  if (maxElements < 1 || !origins.length || !destinations.length) return [];

  /* Deduplicated on the rounded key — two fixes eleven metres apart are one
     place, and paying twice for them is paying for the rounding to do nothing. */
  const uniq = (points: readonly LatLng[]) => {
    const seen = new Map<string, LatLng>();
    for (const p of points) if (!seen.has(legKey(p))) seen.set(legKey(p), p);
    return [...seen.values()];
  };

  const from = uniq(origins);
  const to = uniq(destinations);

  const batches: MatrixBatch[] = [];
  for (let d = 0; d < to.length; d += maxElements) {
    const chunk = to.slice(d, d + maxElements);
    /* How many origins fit beside this many destinations. At least one, or a
       destination chunk at the ceiling would pack zero origins and loop. */
    const perBatch = Math.max(1, Math.floor(maxElements / chunk.length));
    for (let o = 0; o < from.length; o += perBatch) {
      batches.push({ origins: from.slice(o, o + perBatch), destinations: chunk });
    }
  }
  return batches;
}
