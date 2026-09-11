import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dayTrailSegments,
  splitTrailIntoTrips,
  trailMetres,
  tripColour,
  tripOffset,
  TRIP_COLOURS,
} from "./trail-trips";
import { metresBetween } from "../geo";
import { centroidOf, dwellRuns, dwellStops } from "./dwell";

/** Metres → rough degrees of latitude, near enough for a test fixture. */
const M = 1 / 111_320;

function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 8, 8, 4, 0, 0) + minutes * 60_000);
}

/** A run of fixes walking north from `fromM`, one every 6 seconds. */
function walk(fromM: number, toM: number, startMin: number): { lat: number; lng: number; at: Date }[] {
  const out = [];
  const steps = Math.abs(toM - fromM) / 10;
  for (let i = 0; i <= steps; i++) {
    const m = fromM + (toM > fromM ? i * 10 : -i * 10);
    out.push({ lat: 12.9 + m * M, lng: 77.6, at: at(startMin + i * 0.1) });
  }
  return out;
}

/** Standing still at `atM` for `minutes`, a fix every 30 seconds. */
function stand(atM: number, startMin: number, minutes: number) {
  const out = [];
  for (let i = 0; i <= minutes * 2; i++) {
    out.push({ lat: 12.9 + atM * M, lng: 77.6, at: at(startMin + i * 0.5) });
  }
  return out;
}

const OPTS = { gapMetres: 200, dwellRadiusMetres: 30, tripBreakMinutes: 5 };

describe("splitting a day into trips", () => {
  it("a straight walk with no stop is ONE trip", () => {
    const trips = splitTrailIntoTrips(walk(0, 300, 0), OPTS);
    assert.equal(trips.length, 1);
    assert.equal(trips[0].index, 1);
  });

  it("a stop in the middle ends one trip and begins the next", () => {
    const points = [...walk(0, 300, 0), ...stand(300, 1, 10), ...walk(300, 600, 12)];
    const trips = splitTrailIntoTrips(points, OPTS);
    assert.equal(trips.length, 2);
    assert.deepEqual(
      trips.map((t) => t.index),
      [1, 2],
    );
  });

  it("THE SAME ROAD WALKED TWICE IS TWO TRIPS, and they never share a colour", () => {
    /* Out, a stop, and back down the same stretch — the case a single colour
       drew as one line and could not tell apart. */
    const points = [
      ...walk(0, 300, 0),
      ...stand(300, 1, 10),
      ...walk(300, 0, 12),
    ];
    const trips = splitTrailIntoTrips(points, OPTS);
    assert.equal(trips.length, 2);
    assert.notEqual(tripColour(trips[0].index), tripColour(trips[1].index));
  });

  it("consecutive trips SHARE the stop's fix, so the lines meet", () => {
    const points = [...walk(0, 300, 0), ...stand(300, 1, 10), ...walk(300, 600, 12)];
    const [first, second] = splitTrailIntoTrips(points, OPTS);
    const endOfFirst = first.points[first.points.length - 1];
    assert.equal(second.points[0].lat, endOfFirst.lat);
    assert.equal(second.points[0].at.getTime(), endOfFirst.at.getTime());
  });

  it("a gap ends a trip, and the next starts clean on the far side", () => {
    const near = walk(0, 100, 0);
    const far = walk(5000, 5100, 60);
    const trips = splitTrailIntoTrips([...near, ...far], OPTS);
    assert.equal(trips.length, 2);
    /* Not shared across a gap: nobody knows what happened in between, which
       is the same thing the dashed line says. */
    assert.notEqual(trips[1].points[0].lat, trips[0].points[trips[0].points.length - 1].lat);
  });

  it("a stop that runs to the end of the day starts no empty trip after it", () => {
    const trips = splitTrailIntoTrips([...walk(0, 300, 0), ...stand(300, 1, 20)], OPTS);
    assert.equal(trips.length, 1);
  });

  it("a brief pause is not a stop — the trip carries on through it", () => {
    /* Two minutes standing still, under `dwellMinMinutes`. A red light must
       not become a colour change. */
    const points = [...walk(0, 150, 0), ...stand(150, 1, 2), ...walk(150, 300, 4)];
    assert.equal(splitTrailIntoTrips(points, OPTS).length, 1);
  });

  it("agrees with the stop marks the map already draws", () => {
    const points = [...walk(0, 300, 0), ...stand(300, 1, 10), ...walk(300, 600, 12)];
    const stops = dwellStops(points, OPTS.dwellRadiusMetres, OPTS.tripBreakMinutes);
    const trips = splitTrailIntoTrips(points, OPTS);
    /* One stop drawn, one extra trip beyond the first — the mark and the
       colour change describe the same moment. */
    assert.equal(stops.length, 1);
    assert.equal(trips.length, 2);
  });

  it("fewer than two fixes is no journey at all", () => {
    assert.deepEqual(splitTrailIntoTrips([], OPTS), []);
    assert.deepEqual(splitTrailIntoTrips(walk(0, 0, 0), OPTS), []);
  });

  it("distance is the trail's own length, never start to end", () => {
    /* Out and back to where he started: end-to-end is zero, walked is not. */
    const points = [...walk(0, 200, 0), ...walk(200, 0, 3)];
    const [trip] = splitTrailIntoTrips(points, { ...OPTS, tripBreakMinutes: 999 });
    assert.ok(trip.metres > 350, `walked ${Math.round(trip.metres)} m`);
  });

  it("THE COLOUR CHANGES UNDER THE STOP MARK, not where the run happened to end", () => {
    /* Twenty minutes parked, then a walk away. The run holds until he is a
       full radius from where he ARRIVED, so its last fix is out along the
       departure — splitting there put the colour change up the road from the
       circle explaining it. The boundary is the stop's own centre now. */
    const points = [
      ...walk(0, 100, 0),
      ...stand(100, 1, 20),
      ...walk(100, 400, 22),
    ];
    const opts = { gapMetres: 200, dwellRadiusMetres: 60, tripBreakMinutes: 5 };
    const [first, second] = splitTrailIntoTrips(points, opts);
    const boundary = second.points[0];

    const run = dwellRuns(points, opts.dwellRadiusMetres, opts.tripBreakMinutes)[0];
    const centre = centroidOf(points.slice(run.startIndex, run.endIndex + 1));
    const stop = dwellStops(points, opts.dwellRadiusMetres, opts.tripBreakMinutes)[0];

    /* Within a metre of the mark the map draws — the same point, give or take
       the nearest fix to it. */
    const off = Math.abs(boundary.lat - centre.lat) * 111_320;
    assert.ok(off < 1, `boundary sits ${off.toFixed(1)} m from the stop's centre`);
    assert.ok(Math.abs(boundary.lat - stop.lat) * 111_320 < 1);

    /* And the far end of the run is NOT where it split — that is the bug. */
    assert.notEqual(boundary.at.getTime(), points[run.endIndex].at.getTime());
    assert.equal(first.points[first.points.length - 1].at.getTime(), boundary.at.getTime());
  });

  it("a leg shorter than the dwell radius is standing still, not a journey", () => {
    /* Below the radius the dwell rule itself cannot tell movement from a
       stop, so nothing here may claim to. */
    const points = [...walk(0, 30, 0), ...stand(30, 1, 20)];
    assert.deepEqual(splitTrailIntoTrips(points, { gapMetres: 200, dwellRadiusMetres: 60, tripBreakMinutes: 5 }), []);
  });

  it("colours cycle rather than running out", () => {
    assert.equal(tripColour(1), TRIP_COLOURS[0]);
    assert.equal(tripColour(TRIP_COLOURS.length + 1), TRIP_COLOURS[0]);
    assert.equal(tripColour(TRIP_COLOURS.length + 2), TRIP_COLOURS[1]);
  });
});

describe("keeping two passes down one street apart", () => {
  it("offsets every leg to the same side of travel, so out-and-back becomes two lanes", () => {
    /* MapLibre measures `line-offset` from the line's OWN direction, so one
       positive value puts the outbound leg on one side of the road and the
       return leg — travelling the other way — on the other. Nothing here has
       to know which direction a leg went. */
    assert.ok(tripOffset(1) > 0, "an offset of zero draws both passes on top of each other");
  });

  it("staggers legs so two in the SAME direction do not sit on top of each other", () => {
    /* Lanes answer out-and-back; they do not answer walking the same street
       the same way twice, which sits on the same side. */
    assert.notEqual(tripOffset(1), tripOffset(2));
    assert.notEqual(tripOffset(2), tripOffset(3));
  });

  it("keeps the stagger small enough to stay a road rather than a fan", () => {
    const spread = Math.max(tripOffset(1), tripOffset(2), tripOffset(3)) - tripOffset(1);
    assert.ok(spread <= 6, `legs spread ${spread}px, which is wider than a lane`);
  });
});

/*
 * THE MAP HAS TO COVER THE GROUND THE NUMBER CLAIMS.
 *
 * A real day: 132 fixes, 95 after the accuracy filter, 4.07 km of trail — and
 * four hops of 200 m or more carrying 3.85 km of it, because the phone slept
 * between the places he stood still. Each of those hops ends a trip and
 * starts the next clean on the far side, so the hop belongs to no trip; the
 * standing-still between them fails `isJourney`, so those slices go too. One
 * trip survived, of 8 fixes and 71 metres. The panel read "4.1 km" and the
 * map drew seventy-one metres of line.
 *
 * Neither half was wrong on its own. They were two definitions of a day's
 * travel, and the invariant nobody had written down is that they are one.
 */
describe("the whole day reaches the map", () => {
  const OPTS = { gapMetres: 200, dwellRadiusMetres: 60, tripBreakMinutes: 10 };

  /** A day of standing still, teleporting, standing still — the shape above. */
  function sleepyDay() {
    return [
      ...stand(0, 0, 20),
      ...stand(1200, 130, 20),
      ...stand(2500, 260, 20),
    ];
  }

  it("draws every metre the distance figure counts", () => {
    const points = sleepyDay();
    const segments = dayTrailSegments(points, OPTS);

    let drawn = 0;
    for (const s of segments) {
      for (let i = 1; i < s.coordinates.length; i++) {
        const [aLng, aLat] = s.coordinates[i - 1];
        const [bLng, bLat] = s.coordinates[i];
        drawn += metresBetween(aLat, aLng, bLat, bLng);
      }
    }

    const claimed = trailMetres(points);
    assert.ok(claimed > 2000, "the fixture should be a day with real distance in it");
    assert.ok(
      Math.abs(drawn - claimed) < 1,
      `the map draws ${Math.round(drawn)} m of a ${Math.round(claimed)} m day — a figure the line does not account for`,
    );
  });

  it("draws the long hops, and never as a journey", () => {
    const points = sleepyDay();
    const segments = dayTrailSegments(points, OPTS);

    /* The two 1.2 km jumps have to appear in the drawn geometry. Nothing on
       this day is a journey — it is three stops and two hops the phone slept
       through — so `splitTrailIntoTrips` finds nothing, and before this the
       map drew nothing at all. */
    assert.equal(splitTrailIntoTrips(points, OPTS).length, 0, "the fixture must contain no journey");

    const hops: number[] = [];
    for (const s of segments) {
      for (let i = 1; i < s.coordinates.length; i++) {
        const [aLng, aLat] = s.coordinates[i - 1];
        const [bLng, bLat] = s.coordinates[i];
        hops.push(metresBetween(aLat, aLng, bLat, bLng));
      }
    }
    assert.equal(
      hops.filter((m) => m >= OPTS.gapMetres).length,
      2,
      "both long hops must be on the map",
    );

    /* Dashed, and carrying no trip — a hop nobody recorded a path for is not
       a leg, and colouring it as one would put it in the key beside real
       journeys. */
    for (const s of segments) {
      assert.ok(s.gap, "nothing on a day with no journey may be drawn as one");
      assert.equal(s.trip, 0);
    }
  });

  it("covers every consecutive pair exactly once", () => {
    const points = sleepyDay();
    const segments = dayTrailSegments(points, OPTS);
    /* Segments are runs of consecutive pairs, so the hops they hold must add
       up to one less than the number of fixes — no pair dropped, none drawn
       twice. A day that is drawn twice reads as double the distance. */
    const hops = segments.reduce((n, s) => n + s.coordinates.length - 1, 0);
    assert.equal(hops, points.length - 1);
  });

  it("says nothing about a day with one fix", () => {
    assert.deepEqual(dayTrailSegments([{ lat: 12.9, lng: 77.6, at: at(0) }], OPTS), []);
    assert.equal(trailMetres([{ lat: 12.9, lng: 77.6, at: at(0) }]), 0);
  });
});
