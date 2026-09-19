-- The road guessed across a gap in a salesman's trail, cached.
--
-- The Live map already draws the road WHERE THERE ARE FIXES: a dense run goes
-- to Snap-to-Road and what comes back hugs the lane. The straight lines left
-- on it are the stretches with no fixes at all -- cut out by
-- `mbos.location.trailGapMeters` -- and the map has always drawn the crow's
-- flight between their two ends and dashed it, which says honestly that
-- nothing is known about the middle.
--
-- A SHORT GAP IS A DIFFERENT KIND OF ABSENCE FROM A LONG ONE. Ninety seconds
-- under a flyover is a man who was travelling the whole time, with very nearly
-- one way he can have got from the fix before to the fix after; drawing that
-- through three blocks of buildings is a picture nobody can read. Eight hours
-- with the handset off -- and real days on this book carry single gaps of 437,
-- 456, 498 and 999 minutes -- is a stretch where he could have been anywhere,
-- and a road drawn across it would be an invention with the shape of a record.
-- `lib/engines/trail-gap-route.ts` is where that line is drawn and defended.
--
-- IT IS A CACHE AND NOTHING DERIVES FROM IT. Empty it and every gap falls back
-- to the straight dashed line it drew before, which is also exactly what an
-- outage looks like -- so an empty cache and an unreachable Ola are the same
-- already-handled thing.
--
-- Keyed on the ROUNDED coordinate pair, `legKey` in `lib/road-legs.ts`, the
-- same four decimal places `road_legs` uses. A gap's two ends never change
-- once the day is past, and the same two ends recur: the stretch from a man's
-- house to the first shop of the morning is one question asked every morning
-- of the week. DIRECTED, because road geometry is -- one-ways and divided
-- carriageways mean the way back is not the way there reversed.
--
-- The POLYLINE is stored as Ola sent it rather than as decoded points: a tenth
-- of the size, and re-decoding on read means the decoder is exercised by every
-- cache hit rather than only by a fresh fetch.
CREATE TABLE IF NOT EXISTS "trail_gap_routes" (
  "id" text PRIMARY KEY NOT NULL,
  "from_key" text NOT NULL,
  "to_key" text NOT NULL,
  "polyline" text NOT NULL,
  "metres" integer DEFAULT 0 NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "trail_gap_routes_pair_key"
  ON "trail_gap_routes" ("from_key", "to_key");
