-- Road distances, and a pin for a shop nobody has stood in.
--
-- Two things the route engine could not do, both answered by Ola Maps on the
-- key this deployment already holds, and both stored so the same question is
-- never paid for twice.
--
-- ROAD LEGS. The route engine is straight-line by design and says so: the
-- phone is offline in a market lane and a route that arrives beats one that is
-- optimal. That reasoning holds for ORDERING stops and fails for BUDGETING a
-- day -- Mumbai to Pune is 141 km by road against about 120 straight, and
-- inside a city beat the gap is proportionally worse because every lane bends.
-- A day planned on straight-line minutes runs out of hours.
--
-- Keyed on the rounded coordinate rather than on a customer, because a leg
-- starts wherever the salesman is -- his home, a GPS fix, a shop -- and only
-- some of those are rows in `customers`. Four decimal places is about eleven
-- metres, inside the accuracy of the handset fixes themselves, so it cannot
-- lose a distinction the data carries and it stops a re-plan being a fresh
-- bill.
--
-- DIRECTED, because road distance is: one-ways and divided carriageways mean
-- A to B is not always B to A, and a cache that folded them would quietly
-- report the wrong way round.
--
-- It is a CACHE and nothing derives from it that cannot be recomputed. Empty
-- it and every screen falls back to the straight-line answer it gave before,
-- which is exactly what happens today when Ola is unreachable.
CREATE TABLE IF NOT EXISTS "road_legs" (
  "id" text PRIMARY KEY NOT NULL,
  "from_key" text NOT NULL,
  "to_key" text NOT NULL,
  "metres" integer NOT NULL,
  "seconds" integer NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "road_legs_pair_key"
  ON "road_legs" ("from_key", "to_key");
--> statement-breakpoint

-- A PIN THAT WAS LOOKED UP, kept apart from the one somebody stood in.
--
-- `customers.gps_lat` is documented as "where the shop actually is, captured
-- by standing in it", and visit verification reads it before deciding whether
-- somebody was really there. A geocoded coordinate is a different kind of
-- claim entirely and must never land in that column: 503 shops on this book
-- have an address and no pin, and Indian address geocoding outside the metros
-- is unreliable enough that the field pin is nearly always the better record.
-- Asked for a real Nagpur address the API answered with the LOCALITY centre,
-- typed `geometric_center` -- useful for putting a shop roughly on a map, and
-- no basis whatever for saying a salesman stood in it.
--
-- So it is its own column, and `geocoded_precision` carries Ola's own word for
-- how exact it is so a screen can say which kind of pin it is drawing rather
-- than presenting a guess and a measurement identically.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "geocoded_lat" double precision;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "geocoded_lng" double precision;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "geocoded_precision" text;
--> statement-breakpoint
-- What was actually sent, so a bad answer can be told from a bad question.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "geocoded_query" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "geocoded_at" timestamp with time zone;
--> statement-breakpoint

-- The job's own worklist: an address, no pin of either kind, never tried.
CREATE INDEX IF NOT EXISTS "customers_needs_geocode_idx"
  ON "customers" ("geocoded_at")
  WHERE "gps_lat" IS NULL AND "geocoded_at" IS NULL;
