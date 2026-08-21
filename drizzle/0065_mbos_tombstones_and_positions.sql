-- Two things the handset cannot work out for itself.
--
-- **What went away.** A pull tells a handset what exists; nothing tells it what
-- stopped existing. A stop the office removed from tomorrow's route, or a
-- customer reassigned out of somebody's book, simply stays on the phone for
-- ever — the salesman walks to a shop that is not his any more, and nothing
-- anywhere is wrong enough to notice. A delete leaves no row to sync, so it
-- has to leave a tombstone instead.
--
-- `user_id` narrows it: a deletion is only worth sending to the handset that
-- holds the thing. Null means everybody — a product withdrawn from the
-- catalogue is gone for the whole team.
CREATE TABLE IF NOT EXISTS "mbos_deletions" (
  "id" text PRIMARY KEY NOT NULL,
  "entity" text NOT NULL,
  "entity_id" text NOT NULL,
  "user_id" text,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "reason" text
);

CREATE INDEX IF NOT EXISTS "mbos_deletions_at_idx" ON "mbos_deletions" ("at");
CREATE INDEX IF NOT EXISTS "mbos_deletions_user_idx" ON "mbos_deletions" ("user_id", "at");

-- **Where somebody actually went.** MBOS stored a coordinate on a check-in and
-- on each visit, and nothing else — so "the live map" could only ever be a
-- handful of fixes a day, and a map drawn from them would look like tracking
-- without being it.
--
-- This is the stream. The handset posts a position while it is checked in and
-- stops when the day closes, which is the same rule the salesman was already
-- told: tracking runs while you are working and not otherwise.
--
-- It is deliberately thin. No address, no speed, no battery — a position is a
-- lat, a lng, how sure the phone was, and when. Anything more is a thing to
-- justify holding about somebody's day.
CREATE TABLE IF NOT EXISTS "mbos_positions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "at" timestamp with time zone NOT NULL,
  "lat" double precision NOT NULL,
  "lng" double precision NOT NULL,
  "accuracy_m" integer,
  "device_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "mbos_positions"
    ADD CONSTRAINT "mbos_positions_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- The one hot query: one person's day, in order.
CREATE INDEX IF NOT EXISTS "mbos_positions_user_at_idx" ON "mbos_positions" ("user_id", "at");
