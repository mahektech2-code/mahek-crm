-- MATERIAL DUTIES (0232) — who asks for, raises, approves and tests one material.
--
-- One row per person or per department (an ERP designation) per duty. A duty
-- with no rows is unconfigured and behaves exactly as before, so adding the
-- table moves nobody's access.
CREATE TABLE IF NOT EXISTS "erp_material_duties" (
  "id" text PRIMARY KEY NOT NULL,
  "raw_material_id" text NOT NULL REFERENCES "erp_raw_materials"("id") ON DELETE cascade,
  "duty" text NOT NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE cascade,
  "designation_id" text REFERENCES "erp_designations"("id") ON DELETE cascade,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id") ON DELETE set null,
  CONSTRAINT "erp_material_duties_duty_check" CHECK ("duty" in ('request', 'raisePo', 'approve', 'test')),
  CONSTRAINT "erp_material_duties_one_target" CHECK (("user_id" is null) <> ("designation_id" is null))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_material_duties_material_idx" ON "erp_material_duties" ("raw_material_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_material_duties_user_key" ON "erp_material_duties" ("raw_material_id", "duty", "user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_material_duties_designation_key" ON "erp_material_duties" ("raw_material_id", "duty", "designation_id");
