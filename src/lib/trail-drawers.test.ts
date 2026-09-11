/**
 * TWO PLACES DRAW THE TRAIL, AND FIXING ONE CHANGES NOTHING.
 *
 * `street-map.tsx` builds the line from the raw fixes, and
 * `api/sales/live/snap-trail` builds the road-matched one. The client draws
 * its own and then REPLACES the geometry with whatever the route answers —
 * `source.setData(trailFeatureCollection(body.segments))` — so the route wins
 * whenever it answers at all, which is every day with a trail on it.
 *
 * That is how the first fix for this landed, shipped, deployed, and moved
 * nothing on screen. The client was corrected to cover the whole day; the
 * route still walked `trips` and answered with one 71-metre leg of a 4.07 km
 * day, and the corrected geometry was overwritten by it within a second of
 * being drawn. Nothing failed. The map just looked exactly as wrong as before.
 *
 * `dayTrailSegments` is the shared answer to "what is on the map", and the
 * check is that both builders go through it rather than cutting the day up
 * themselves. This is a text check because there is nothing else it could be:
 * one side is a React component and the other a route handler, and what joins
 * them is that they must agree about the same day.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

const MAP = "src/app/sales/live/street-map.tsx";
const ROUTE = "src/app/api/sales/live/snap-trail/route.ts";

test("both trail drawers build from dayTrailSegments", () => {
  for (const file of [MAP, ROUTE]) {
    const source = readFileSync(file, "utf8");
    assert.ok(
      source.includes("dayTrailSegments("),
      `${file} no longer builds its line from dayTrailSegments — it will draw the journeys and drop the rest of the day`,
    );
  }
});

test("neither drawer builds its segments by walking trips", () => {
  for (const file of [MAP, ROUTE]) {
    const source = readFileSync(file, "utf8");
    /* `for (const trip of trips)` is the exact shape of the bug: a loop over
       journeys, pushing one segment per piece of each, with every hop that
       belongs to no journey silently absent from the map. Reading the trips
       for their LENGTHS is fine and both still do it — it is building the
       geometry from them that loses the day. */
    assert.ok(
      !/for\s*\(\s*const\s+\w+\s+of\s+trips\s*\)/.test(source),
      `${file} walks trips to build its line — every hop outside a journey will be missing`,
    );
  }
});

test("neither drawer hands a no-journey segment to a 1-based helper", () => {
  /* `tripColour` and `tripOffset` both compute `(index - 1) % n`, so NO_TRIP
     asks for element -1 — undefined straight into a MapLibre paint property —
     and staggers the offset the wrong way off the line. A day of nothing but
     jumps between stops is ALL no-journey, so this is the ordinary case on
     exactly the day the whole change was made for. */
  for (const file of [MAP, ROUTE]) {
    const source = readFileSync(file, "utf8");
    assert.ok(
      source.includes("NO_TRIP_COLOUR"),
      `${file} has no colour for ground in no journey, so tripColour will hand MapLibre undefined`,
    );
  }
});
