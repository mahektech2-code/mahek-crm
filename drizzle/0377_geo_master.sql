-- The official geography master and who works where in it. ADDITIVE ONLY: six new
-- tables and one allocation table. Nothing existing is altered, `mbos_user_territories`
-- is untouched, and no row is inserted — the master stays EMPTY until a reviewed
-- snapshot is loaded (see src/lib/geography/geo-snapshot.ts).
CREATE TABLE IF NOT EXISTS "geo_sources" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "source_class" text NOT NULL,
  "url" text,
  "observed_on" date,
  "retrieved_on" date,
  "checksum" text,
  "licence_status" text DEFAULT 'unverified' NOT NULL,
  "licence_note" text,
  "approved_by_id" text,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "geo_units" (
  "id" text PRIMARY KEY NOT NULL,
  "level" text NOT NULL,
  "lgd_code" text NOT NULL,
  "version" integer,
  "name" text NOT NULL,
  "name_key" text NOT NULL,
  "parent_id" text,
  "census_2011_code" text,
  "state_or_ut" text,
  "source_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "geo_units_level_check" CHECK ("level" in ('state', 'district', 'subdistrict')),
  CONSTRAINT "geo_units_parent_check" CHECK (("level" = 'state') = ("parent_id" is null))
);

CREATE TABLE IF NOT EXISTS "geo_local_bodies" (
  "id" text PRIMARY KEY NOT NULL,
  "lgd_code" text NOT NULL,
  "version" integer,
  "name" text NOT NULL,
  "name_key" text NOT NULL,
  "name_local" text,
  "type_code" text,
  "state_unit_id" text NOT NULL,
  "census_2011_code" text,
  "source_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "geo_ulb_subdistricts" (
  "ulb_id" text NOT NULL,
  "subdistrict_id" text NOT NULL,
  "district_id" text NOT NULL,
  "village_rows" integer DEFAULT 0 NOT NULL,
  "source_id" text NOT NULL,
  CONSTRAINT "geo_ulb_subdistricts_ulb_id_subdistrict_id_pk" PRIMARY KEY ("ulb_id", "subdistrict_id")
);

CREATE TABLE IF NOT EXISTS "geo_ulb_districts" (
  "ulb_id" text NOT NULL,
  "district_id" text NOT NULL,
  "source_id" text NOT NULL,
  CONSTRAINT "geo_ulb_districts_ulb_id_district_id_pk" PRIMARY KEY ("ulb_id", "district_id")
);

CREATE TABLE IF NOT EXISTS "geo_unresolved_records" (
  "id" text PRIMARY KEY NOT NULL,
  "source_id" text NOT NULL,
  "kind" text NOT NULL,
  "lgd_code" text NOT NULL,
  "name" text,
  "state_name" text,
  "note" text,
  CONSTRAINT "geo_unresolved_kind_check" CHECK ("kind" in ('no_coverage', 'orphan_coverage'))
);

CREATE TABLE IF NOT EXISTS "mbos_user_geo_territories" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "level" text NOT NULL,
  "unit_id" text,
  "ulb_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  CONSTRAINT "mbos_user_geo_territories_level_check" CHECK ("level" in ('state', 'district', 'subdistrict', 'ulb')),
  CONSTRAINT "mbos_user_geo_territories_one_target_check" CHECK (("level" = 'ulb' and "ulb_id" is not null and "unit_id" is null) or ("level" <> 'ulb' and "unit_id" is not null and "ulb_id" is null))
);

DO $$ BEGIN
  ALTER TABLE "geo_units" ADD CONSTRAINT "geo_units_parent_id_geo_units_id_fk" FOREIGN KEY ("parent_id") REFERENCES "geo_units"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "geo_units" ADD CONSTRAINT "geo_units_source_id_geo_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "geo_sources"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "geo_local_bodies" ADD CONSTRAINT "geo_local_bodies_state_unit_id_geo_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "geo_units"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "geo_local_bodies" ADD CONSTRAINT "geo_local_bodies_source_id_geo_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "geo_sources"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "geo_ulb_subdistricts" ADD CONSTRAINT "geo_ulb_subdistricts_ulb_id_geo_local_bodies_id_fk" FOREIGN KEY ("ulb_id") REFERENCES "geo_local_bodies"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "geo_ulb_subdistricts" ADD CONSTRAINT "geo_ulb_subdistricts_subdistrict_id_geo_units_id_fk" FOREIGN KEY ("subdistrict_id") REFERENCES "geo_units"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "geo_ulb_subdistricts" ADD CONSTRAINT "geo_ulb_subdistricts_district_id_geo_units_id_fk" FOREIGN KEY ("district_id") REFERENCES "geo_units"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "geo_ulb_subdistricts" ADD CONSTRAINT "geo_ulb_subdistricts_source_id_geo_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "geo_sources"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "geo_ulb_districts" ADD CONSTRAINT "geo_ulb_districts_ulb_id_geo_local_bodies_id_fk" FOREIGN KEY ("ulb_id") REFERENCES "geo_local_bodies"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "geo_ulb_districts" ADD CONSTRAINT "geo_ulb_districts_district_id_geo_units_id_fk" FOREIGN KEY ("district_id") REFERENCES "geo_units"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "geo_ulb_districts" ADD CONSTRAINT "geo_ulb_districts_source_id_geo_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "geo_sources"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "geo_unresolved_records" ADD CONSTRAINT "geo_unresolved_records_source_id_geo_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "geo_sources"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "mbos_user_geo_territories" ADD CONSTRAINT "mbos_user_geo_territories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "mbos_user_geo_territories" ADD CONSTRAINT "mbos_user_geo_territories_unit_id_geo_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "geo_units"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "mbos_user_geo_territories" ADD CONSTRAINT "mbos_user_geo_territories_ulb_id_geo_local_bodies_id_fk" FOREIGN KEY ("ulb_id") REFERENCES "geo_local_bodies"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "geo_units_level_code_key" ON "geo_units" ("level", "lgd_code");
CREATE INDEX IF NOT EXISTS "geo_units_parent_idx" ON "geo_units" ("parent_id");
CREATE UNIQUE INDEX IF NOT EXISTS "geo_local_bodies_code_key" ON "geo_local_bodies" ("lgd_code");
CREATE INDEX IF NOT EXISTS "geo_local_bodies_state_idx" ON "geo_local_bodies" ("state_unit_id");
CREATE INDEX IF NOT EXISTS "geo_ulb_subdistricts_sub_idx" ON "geo_ulb_subdistricts" ("subdistrict_id");
CREATE INDEX IF NOT EXISTS "geo_ulb_districts_district_idx" ON "geo_ulb_districts" ("district_id");
CREATE INDEX IF NOT EXISTS "geo_unresolved_source_idx" ON "geo_unresolved_records" ("source_id", "kind");
CREATE UNIQUE INDEX IF NOT EXISTS "mbos_user_geo_territories_unit_key" ON "mbos_user_geo_territories" ("user_id", "unit_id") WHERE "unit_id" is not null;
CREATE UNIQUE INDEX IF NOT EXISTS "mbos_user_geo_territories_ulb_key" ON "mbos_user_geo_territories" ("user_id", "ulb_id") WHERE "ulb_id" is not null;
CREATE INDEX IF NOT EXISTS "mbos_user_geo_territories_user_idx" ON "mbos_user_geo_territories" ("user_id");
