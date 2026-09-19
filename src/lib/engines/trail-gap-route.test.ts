import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodePolyline,
  gapVerdict,
  joinGapPath,
  pathMetres,
  routeIsBelievable,
  type GapRouteLimits,
} from "./trail-gap-route";
import { metresBetween } from "../geo";

const LIMITS: GapRouteLimits = { maxMinutes: 8, maxKm: 3 };

/** Metres → rough degrees of latitude, near enough for a fixture. */
const M = 1 / 111_320;

const NAGPUR = { lat: 21.1458, lng: 79.0882 };

function north(from: { lat: number; lng: number }, metres: number) {
  return { lat: from.lat + metres * M, lng: from.lng };
}

describe("gapVerdict", () => {
  it("routes a short gap — a flyover, a lift, a reaped tracker", () => {
    const v = gapVerdict(
      { from: NAGPUR, to: north(NAGPUR, 400), fromMs: 0, toMs: 90_000 },
      LIMITS,
    );
    assert.equal(v.route, true);
    assert.ok(v.straightMetres > 380 && v.straightMetres < 420);
    assert.ok(Math.abs(v.minutes - 1.5) < 0.01);
  });

  it("refuses a gap the clock cannot account for", () => {
    /* The real days on this book carry single gaps of 437 and 999 minutes. */
    const v = gapVerdict(
      { from: NAGPUR, to: north(NAGPUR, 400), fromMs: 0, toMs: 999 * 60_000 },
      LIMITS,
    );
    assert.equal(v.route, false);
    assert.equal(v.route === false && v.why, "tooLong");
  });

  it("refuses a gap too far across, however short the silence", () => {
    const v = gapVerdict(
      { from: NAGPUR, to: north(NAGPUR, 40_000), fromMs: 0, toMs: 60_000 },
      LIMITS,
    );
    assert.equal(v.route, false);
    assert.equal(v.route === false && v.why, "tooFar");
  });

  it("refuses a gap between a point and itself", () => {
    const v = gapVerdict({ from: NAGPUR, to: { ...NAGPUR }, fromMs: 0, toMs: 60_000 }, LIMITS);
    assert.equal(v.route, false);
    assert.equal(v.route === false && v.why, "notAGap");
  });

  it("reads the ceilings from the limits it is given, not from itself", () => {
    const gap = { from: NAGPUR, to: north(NAGPUR, 5_000), fromMs: 0, toMs: 20 * 60_000 };
    assert.equal(gapVerdict(gap, LIMITS).route, false);
    assert.equal(gapVerdict(gap, { maxMinutes: 30, maxKm: 10 }).route, true);
  });

  it("treats a backwards clock as no time at all rather than as a negative", () => {
    const v = gapVerdict(
      { from: NAGPUR, to: north(NAGPUR, 300), fromMs: 60_000, toMs: 0 },
      LIMITS,
    );
    assert.equal(v.route, true);
    assert.equal(v.minutes, 0);
  });
});

describe("routeIsBelievable", () => {
  it("accepts a road somewhat longer than the crow's flight", () => {
    assert.equal(routeIsBelievable(400, 620, LIMITS), true);
  });

  it("refuses a road longer than a routable gap may span", () => {
    /* The river with no bridge: a perfectly correct route, and not the one he
       took across a ninety-second gap. */
    assert.equal(routeIsBelievable(400, 15_000, LIMITS), false);
  });

  it("refuses a road shorter than the straight line — geometry misread", () => {
    assert.equal(routeIsBelievable(400, 120, LIMITS), false);
  });

  it("refuses nothing at all", () => {
    assert.equal(routeIsBelievable(400, 0, LIMITS), false);
    assert.equal(routeIsBelievable(400, Number.NaN, LIMITS), false);
  });

  it("allows a straight road to equal its own crow's flight", () => {
    assert.equal(routeIsBelievable(400, 400, LIMITS), true);
  });
});

describe("joinGapPath", () => {
  const from = NAGPUR;
  const to = north(NAGPUR, 400);

  it("starts and ends on the real fixes, whatever Ola returned", () => {
    const routed = [north(from, 6), north(from, 200), north(from, 394)];
    const path = joinGapPath(from, to, routed);
    assert.deepEqual(path[0], [from.lng, from.lat]);
    assert.deepEqual(path[path.length - 1], [to.lng, to.lat]);
  });

  it("drops Ola's own ends where they sit on top of the real ones", () => {
    const routed = [north(from, 6), north(from, 200), north(from, 394)];
    /* Two real ends plus the one middle point — the two near-duplicates gone. */
    assert.equal(joinGapPath(from, to, routed).length, 3);
  });

  it("keeps an end Ola placed genuinely far off, rather than hiding it", () => {
    const routed = [north(from, 80), north(from, 200), north(from, 320)];
    assert.equal(joinGapPath(from, to, routed).length, 5);
  });

  it("answers the bare straight line where Ola returned nothing", () => {
    assert.deepEqual(joinGapPath(from, to, []), [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ]);
  });

  it("answers [lng, lat], which is not the order Ola speaks", () => {
    const path = joinGapPath(from, to, [north(from, 200)]);
    for (const [lng, lat] of path) {
      assert.ok(lng > 78 && lng < 80, `longitude in the first slot, got ${lng}`);
      assert.ok(lat > 20 && lat < 22, `latitude in the second slot, got ${lat}`);
    }
  });
});

describe("decodePolyline", () => {
  it("decodes Google's own worked example", () => {
    /* From the encoded-polyline specification: (38.5,-120.2), (40.7,-120.95),
       (43.252,-126.453). A decoder off by a factor of ten answers a well-formed
       line in the wrong ocean, which nothing else in the stack would notice. */
    const points = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    assert.equal(points.length, 3);
    const expected = [
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ];
    points.forEach((p, i) => {
      assert.ok(Math.abs(p.lat - expected[i].lat) < 1e-5, `lat ${i}: ${p.lat}`);
      assert.ok(Math.abs(p.lng - expected[i].lng) < 1e-5, `lng ${i}: ${p.lng}`);
    });
  });

  it("answers nothing for nothing", () => {
    assert.deepEqual(decodePolyline(""), []);
  });

  it("keeps what decoded cleanly rather than throwing on a truncated string", () => {
    const whole = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
    const cut = decodePolyline(whole.slice(0, whole.length - 3));
    assert.ok(cut.length >= 2, "the pairs that did decode are still worth having");
  });
});

describe("pathMetres", () => {
  it("measures the drawn geometry hop by hop", () => {
    const metres = pathMetres([NAGPUR, north(NAGPUR, 300), north(NAGPUR, 800)]);
    assert.ok(Math.abs(metres - 800) < 5, `got ${metres}`);
  });

  it("is zero for a line of one point", () => {
    assert.equal(pathMetres([NAGPUR]), 0);
  });

  it("agrees with the straight-line measure on a two-point line", () => {
    const to = north(NAGPUR, 250);
    assert.equal(
      pathMetres([NAGPUR, to]),
      metresBetween(NAGPUR.lat, NAGPUR.lng, to.lat, to.lng),
    );
  });
});
