-- A person may work in several factory departments. `areas` is the whole
-- list; `area` stays as the first of it (their home department), so every
-- reader that only knows one department keeps reading the one it read.
ALTER TABLE "factory_staff" ADD COLUMN IF NOT EXISTS "areas" text[] NOT NULL DEFAULT '{}'::text[];--> statement-breakpoint
UPDATE "factory_staff" SET "areas" = ARRAY["area"] WHERE cardinality("areas") = 0;--> statement-breakpoint
ALTER TABLE "factory_staff" ADD CONSTRAINT "factory_staff_areas_check" CHECK ("areas" <@ ARRAY['head','mixing','filling','packing','dispatch','qc']::text[] AND cardinality("areas") > 0 AND "area" = ANY("areas"));
