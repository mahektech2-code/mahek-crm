import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitTrailIntoTrips, tripColour, TRIP_COLOURS } from "./trail-trips";
import { dwellStops } from "./dwell";

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

const OPTS = { gapMetres: 200, dwellRadiusMetres: 30, dwellMinMinutes: 5 };

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
    const stops = dwellStops(points, OPTS.dwellRadiusMetres, OPTS.dwellMinMinutes);
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
    const [trip] = splitTrailIntoTrips(points, { ...OPTS, dwellMinMinutes: 999 });
    assert.ok(trip.metres > 350, `walked ${Math.round(trip.metres)} m`);
  });

  it("colours cycle rather than running out", () => {
    assert.equal(tripColour(1), TRIP_COLOURS[0]);
    assert.equal(tripColour(TRIP_COLOURS.length + 1), TRIP_COLOURS[0]);
    assert.equal(tripColour(TRIP_COLOURS.length + 2), TRIP_COLOURS[1]);
  });
});
