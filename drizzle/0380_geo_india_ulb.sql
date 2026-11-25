-- ADDITIVE ONLY. The All-India city/town load needs two things the master lacked:
-- the local-body TYPE AS THE SOURCE NAMES IT (a type CODE is not a reliable label across
-- states), and a place to keep the review flags the source file carries. No row is
-- touched or removed.
ALTER TABLE "geo_local_bodies" ADD COLUMN IF NOT EXISTS "type_name" text;

CREATE TABLE IF NOT EXISTS "geo_review_flags" (
  "id" text PRIMARY KEY NOT NULL,
  "source_id" text NOT NULL,
  "ulb_id" text NOT NULL,
  "district_id" text,
  "flag" text NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "geo_review_flags_flag_check" CHECK ("flag" in ('unresolved', 'several_districts', 'cantonment_not_in_first_master'))
);

DO $$ BEGIN
  ALTER TABLE "geo_review_flags" ADD CONSTRAINT "geo_review_flags_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "geo_sources"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "geo_review_flags" ADD CONSTRAINT "geo_review_flags_ulb_id_fk" FOREIGN KEY ("ulb_id") REFERENCES "geo_local_bodies"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "geo_review_flags" ADD CONSTRAINT "geo_review_flags_district_id_fk" FOREIGN KEY ("district_id") REFERENCES "geo_units"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "geo_review_flags_ulb_idx" ON "geo_review_flags" ("ulb_id");
CREATE INDEX IF NOT EXISTS "geo_review_flags_source_idx" ON "geo_review_flags" ("source_id", "flag");
