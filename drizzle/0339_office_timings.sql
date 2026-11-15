-- OFFICE TIMINGS (Nov 2026). An office's working week, one row per working
-- weekday; no row is a week off. A person with rows of their own in
-- hrms_staff_timings keeps them, and they replace the office's week whole.
CREATE TABLE IF NOT EXISTS "hrms_office_timings" (
  "id" text PRIMARY KEY NOT NULL,
  "office_id" text NOT NULL REFERENCES "hrms_offices"("id") ON DELETE CASCADE,
  "weekday" text NOT NULL,
  "in_time" text NOT NULL,
  "out_time" text NOT NULL,
  "present_min" integer,
  "half_min" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hrms_office_timings_key" ON "hrms_office_timings" ("office_id","weekday");
