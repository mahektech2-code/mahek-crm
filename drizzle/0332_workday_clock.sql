-- The workday clock: punch in, breaks, idle and the lock, for office days.
--
-- An office day becomes a list of working stretches, the MBOS handset's own
-- shape, and the three columns every report already reads (check_in,
-- check_out, stoppage_min) become mirrors of that list. Nothing that exists is
-- rewritten: a row with an empty list is read as one stretch from its
-- check-in to its check-out, so every day already recorded means what it did.

ALTER TABLE "hrms_attendance" ADD COLUMN IF NOT EXISTS "sessions" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "hrms_attendance" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp with time zone;
ALTER TABLE "hrms_attendance" ADD COLUMN IF NOT EXISTS "off_day" text;
ALTER TABLE "hrms_attendance" ADD COLUMN IF NOT EXISTS "present_min" integer;
ALTER TABLE "hrms_attendance" ADD COLUMN IF NOT EXISTS "half_min" integer;

ALTER TABLE "hrms_staff_timings" ADD COLUMN IF NOT EXISTS "present_min" integer;
ALTER TABLE "hrms_staff_timings" ADD COLUMN IF NOT EXISTS "half_min" integer;

CREATE TABLE IF NOT EXISTS "hrms_workday_claims" (
  "id" text PRIMARY KEY NOT NULL,
  "attendance_id" text NOT NULL REFERENCES "hrms_attendance"("id") ON DELETE CASCADE,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "date" date NOT NULL,
  "from_at" timestamp with time zone NOT NULL,
  "to_at" timestamp with time zone NOT NULL,
  "kind" text NOT NULL,
  "category" text NOT NULL,
  "note" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "decided_by_id" text,
  "decided_at" timestamp with time zone,
  "decided_note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "hrms_workday_claims_kind" CHECK ("kind" in ('auto_break','auto_out')),
  CONSTRAINT "hrms_workday_claims_status" CHECK ("status" in ('pending','approved','declined')),
  CONSTRAINT "hrms_workday_claims_span" CHECK ("to_at" > "from_at")
);
CREATE INDEX IF NOT EXISTS "hrms_workday_claims_emp_idx" ON "hrms_workday_claims" ("employee_id","date");
CREATE INDEX IF NOT EXISTS "hrms_workday_claims_status_idx" ON "hrms_workday_claims" ("status");
