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
import { checkConsistency, defaultConfig } from "@/lib/config/registry";

const MAP = "src/app/sales/live/street-map.tsx";
const ROUTE = "src/app/api/sales/live/snap-trail/route.ts";

/* ---------------------------------------------------------------------------
 * THE CADENCE THAT FEEDS BOTH OF THEM.
 *
 * Neither drawer can draw a road that was never recorded. The trail spent two
 * days as thirty-nine points joined by straight lines because the floor on
 * what is KEPT was five minutes while the ceiling on what is ASKED for was
 * three seconds — a pair that is not wrong in either half and is useless
 * together.
 * ------------------------------------------------------------------------- */

test("a fix is kept as often as one is taken", () => {
  const config = defaultConfig();
  /* Equal is the point, not merely "not less". Every fix the handset pays the
     battery to take is one that reaches the map; anything higher discards
     fixes already bought and costs road shape for nothing but rows. */
  assert.equal(
    config["mbos.location.trailKeepEverySeconds"],
    config["mbos.location.trackEverySeconds"],
    "the trail keeps fixes less often than it takes them — the Live map will draw straight lines between stops",
  );
});

test("a keep floor shorter than the take interval is refused", () => {
  const bad = defaultConfig();
  bad["mbos.location.trackEverySeconds"] = 30;
  bad["mbos.location.trailKeepEverySeconds"] = 3;
  assert.ok(
    checkConsistency(bad).some((p) => /keep interval at or above/i.test(p)),
    "asking to keep a fix every 3s while taking one every 30s cannot be honoured, and must not save quietly",
  );
  assert.equal(
    checkConsistency(defaultConfig()).filter((p) => /keep interval at or above/i.test(p)).length,
    0,
    "the shipped defaults must not trip the rule",
  );
});

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

/* ---------------------------------------------------------------------------
 * THE TRAIL MAY NOT ASK FOR A PRECISION THE MAP WILL REFUSE.
 *
 * `dropInaccurateFixes` discards any trail fix worse than
 * `mbos.location.gpsAccuracyThresholdM` (50 m). `Location.Accuracy.Balanced`
 * on Android is roughly a city block and returns 100 m indoors — so a trail
 * taken at Balanced is one the screen has already decided to throw away. It
 * was, for the life of the module: 14 of 96 fixes in half an hour on a real
 * handset were woken for, kept, uploaded, stored and then dropped unseen, and
 * in the last two minutes of that window 3 of 3 were, so the trail stopped
 * growing while every health signal read green.
 *
 * A text check because there is nothing else it could be — one side is an
 * Expo module the server's tests cannot import, and what joins them is that a
 * number in the registry and an enum on a handset have to agree.
 * ------------------------------------------------------------------------- */

const TRAIL = "mbos-app/src/sync/trail.ts";

test("the trail records at a precision the map will actually draw", () => {
  const source = readFileSync(TRAIL, "utf8");

  assert.ok(
    /accuracy:\s*Location\.Accuracy\.High/.test(source),
    `${TRAIL} no longer asks for High accuracy — at Balanced (~100 m) every fix it takes is dropped by dropInaccurateFixes and the trail silently stops growing`,
  );
  assert.ok(
    !/accuracy:\s*Location\.Accuracy\.Balanced/.test(source),
    `${TRAIL} asks for Balanced somewhere — that is a city-block reading feeding a line that claims to be the road ridden`,
  );
  /* The floor has to match the task, or the trail's precision depends on
     whether the OS background task happened to start. */
  assert.ok(
    /getFix\(\{[^}]*precise:\s*true/.test(source),
    `${TRAIL}'s foreground floor no longer asks for a precise fix — it will store coarse fixes the map then discards`,
  );
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

/* ---------------------------------------------------------------------------
 * AND THE TRAIL HAS TO BE DELIVERED, NOT MERELY TAKEN.
 *
 * `deferredUpdatesInterval` is the one of expo-location's intervals Android
 * actually honours, and it decides when the app is TOLD about a fix rather
 * than how often one is taken. Set to the sampling interval it batches in the
 * background and is bypassed in the foreground — and that asymmetry meant a
 * pocketed handset handed MBOS nothing at all. 123 fixes at three-second
 * spacing across eight and a half minutes arrived in ONE delivery, the moment
 * the app came forward: `store()` never ran, `flush()` never ran, and the
 * office saw not a stale position but no position, for as long as the phone
 * stayed in a pocket.
 *
 * Zero is the only value that makes background tracking mean anything. A text
 * check because the alternative is a device: `trail.ts` imports expo-location
 * and TaskManager at module scope, which is the same reason the cadence and
 * the watchdog both had to be moved into `engines/` to be testable at all.
 * ------------------------------------------------------------------------- */

test("the trail is delivered as it happens, not batched until the app opens", () => {
  const source = readFileSync(TRAIL, "utf8");

  assert.ok(
    /deferredUpdatesInterval:\s*0\b/.test(source),
    `${TRAIL} defers location delivery — Android will hold the batch until the app is foregrounded, and the Live map shows nothing while the phone is in a pocket`,
  );
  /* The distance twin, which was always 0 and must stay so: a salesman
     standing still in a shop is a fact the trail wants, and distance-gating
     drops the dwell that proves he was there. */
  assert.ok(
    /deferredUpdatesDistance:\s*0\b/.test(source),
    `${TRAIL} gates delivery on distance — a stationary salesman will vanish from his own trail`,
  );
});

/* ---------------------------------------------------------------------------
 * A FIX IS NEVER DROPPED EXCEPT ON A CLEAN ANSWER FROM THIS SERVER.
 *
 * The whole durability promise rests on it: a handset that syncs once in a
 * while must still deliver every fix it took, because the queue holds them
 * until we confirm. That guarantee lives in three `DELETE` statements and
 * nothing checked it — it was verified by reading them, which is exactly the
 * kind of thing that stays true until somebody adds a fourth.
 *
 * The three legitimate deletions are: rows the server just acknowledged; the
 * whole queue when the office has switched tracking OFF (keeping them would be
 * storing what nobody asked for); and rows past the retention window on
 * `no-session-yet`, so a queue waiting for a check-in that is never coming
 * cannot grow for ever.
 * ------------------------------------------------------------------------- */

test("queued fixes are deleted only on a clean answer", () => {
  const source = readFileSync(TRAIL, "utf8");
  const deletes = source.match(/DELETE FROM positions[^']*/g) ?? [];

  assert.equal(
    deletes.length,
    3,
    `trail.ts has ${deletes.length} deletions of the position queue, not the 3 that are accounted for — a new one is a new way to lose somebody's day: ${JSON.stringify(deletes)}`,
  );

  /* The acknowledged rows, named by id. Anything broader here would drop fixes
     the server never saw. */
  assert.ok(
    deletes.some((d) => /WHERE id IN \(/.test(d)),
    "the post-acknowledgement delete no longer names the rows it is deleting",
  );
  /* The retention sweep, and it must stay bounded by a time. An unqualified
     delete on this path would throw away a morning to win a race with the
     outbox. */
  assert.ok(
    deletes.some((d) => /WHERE at < \?/.test(d)),
    "the retention sweep no longer bounds itself by age",
  );
  /* And it reads the window from configuration rather than a constant. */
  assert.ok(
    /await retentionMs\(\)/.test(source),
    "the retention window is hardcoded again — how durable somebody's day is belongs in the registry",
  );
});
