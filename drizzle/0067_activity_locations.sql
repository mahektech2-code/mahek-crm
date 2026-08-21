-- Where each thing was done.
--
-- Four tables carried a coordinate — visits, leads, attendance and the trail —
-- and the other twenty-three did not, so an order taken at a shop, a payment
-- collected at a counter and a complaint raised in a godown were all recorded
-- with no idea where they happened.
--
-- **One table rather than a lat/lng pair on each.** "Where was this done" is
-- one question with one answer shape, and answering it in twelve places is
-- answering it in eleven and forgetting the twelfth — which is exactly the
-- state this replaces. It also means the thirteenth kind of activity costs
-- nothing to cover, and that retention has one place to reach.
--
-- **A row can say there was NO fix.** `lat` null with a reason is the record
-- that we asked and could not get one — indoors in a concrete godown, or
-- permission refused. No row at all means nothing asked. The two are different
-- facts and a screen that could not tell them apart would read "no location"
-- for both.
--
-- **`captured_at` is not `created_at`.** One is when the phone got the fix and
-- the other is when the row was written; the gap between them is the whole
-- reason `age_seconds` exists, because a fix from four minutes ago is evidence
-- and one from four hours ago is not.
CREATE TABLE IF NOT EXISTS "mbos_activity_locations" (
  "id" text PRIMARY KEY NOT NULL,
  /* The handset's own entity type — `order`, `payment`, `sample`, … */
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "user_id" text NOT NULL,
  "lat" double precision,
  "lng" double precision,
  /* Part of the reading, never a filter. A 500 m fix is not a doorway and is
     still worth having; it is recorded as what it is. */
  "accuracy_m" integer,
  /* When the FIX was taken, by the handset's clock. */
  "captured_at" timestamp with time zone,
  /* How old that fix was when the activity was recorded. Age is part of the
     reading exactly as accuracy is. */
  "age_seconds" integer,
  /* `fresh` — taken for this act. `trail` — the most recent one the day's
     tracking had already taken, which is why this costs no battery. */
  "source" text,
  /* Set only where there are no coordinates: denied, unavailable, off. */
  "reason" text,
  "device_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "mbos_activity_locations"
    ADD CONSTRAINT "mbos_activity_locations_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- One location per activity. A retried sync writes the same row rather than a
-- second one, which is what makes the ingest idempotent without asking.
CREATE UNIQUE INDEX IF NOT EXISTS "mbos_activity_locations_entity_key"
  ON "mbos_activity_locations" ("entity_type", "entity_id");

-- The two hot reads: one person's day, and everything at one activity kind.
CREATE INDEX IF NOT EXISTS "mbos_activity_locations_user_idx"
  ON "mbos_activity_locations" ("user_id", "captured_at");
