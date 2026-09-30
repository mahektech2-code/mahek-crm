-- HRMS: the Mahek EMP 2.0 rebuild (docs/hrms). The employee master stops
-- being only a mirror of the sheet, and the app gains its own records:
-- offices, timings, attendance, leave, holidays, overtime, payroll, advances,
-- expenses, tasks, KPIs, reviews, sales desk rows, assets, help, grievances,
-- documents and notifications. Every new table is additive; nothing existing
-- changes meaning.

ALTER TYPE "attachment_parent" ADD VALUE IF NOT EXISTS 'hrms_attendance';
--> statement-breakpoint
ALTER TYPE "attachment_parent" ADD VALUE IF NOT EXISTS 'hrms_employee';
--> statement-breakpoint
ALTER TYPE "attachment_parent" ADD VALUE IF NOT EXISTS 'hrms_office';
--> statement-breakpoint
ALTER TYPE "attachment_parent" ADD VALUE IF NOT EXISTS 'hrms_asset';
--> statement-breakpoint
ALTER TYPE "attachment_parent" ADD VALUE IF NOT EXISTS 'hrms_document';
--> statement-breakpoint
ALTER TYPE "attachment_parent" ADD VALUE IF NOT EXISTS 'hrms_journey';
--> statement-breakpoint

-- Monthly paid leave is 1.5 days as often as not; an integer could not hold it.
ALTER TABLE "employees" ALTER COLUMN "monthly_paid_leave" TYPE numeric(5, 2);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'sheet' NOT NULL;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "hrms_decided_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "photo_attachment_id" text;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "id_card_attachment_id" text;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "account_number" text;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "aadhaar_number" text;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "target_visits" integer;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "target_km" integer;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "target_litres" integer;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "target_hours" integer;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "target_amount_paise" bigint;
--> statement-breakpoint

ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "rating" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "segmentation" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "special_instructions" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "tagged_employee_name" text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_offices" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "city" text,
  "state" text,
  "region" text,
  "lat" double precision,
  "lng" double precision,
  "address" text,
  "radius_m" integer DEFAULT 200 NOT NULL,
  "opening_time" text,
  "closing_time" text,
  "timing_type" text DEFAULT 'Full Day' NOT NULL,
  "paid_leave_note" text,
  "image_attachment_id" text,
  "qr_text" text,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hrms_offices_name_key" ON "hrms_offices" ("name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hrms_offices_qr_key" ON "hrms_offices" ("qr_text");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_staff_timings" (
  "id" text PRIMARY KEY NOT NULL,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "weekday" text NOT NULL,
  "in_time" text NOT NULL,
  "out_time" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hrms_staff_timings_key" ON "hrms_staff_timings" ("employee_id", "weekday");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_attendance" (
  "id" text PRIMARY KEY NOT NULL,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "date" date NOT NULL,
  "office_name" text,
  "method" text DEFAULT 'geo' NOT NULL,
  "check_in" text NOT NULL,
  "check_out" text,
  "stoppage_min" integer DEFAULT 0 NOT NULL,
  "official_in" text,
  "official_out" text,
  "target_min" integer,
  "lat" double precision,
  "lng" double precision,
  "accuracy_m" integer,
  "distance_m" integer,
  "out_lat" double precision,
  "out_lng" double precision,
  "out_distance_m" integer,
  "check_in_code" text,
  "in_photo_id" text,
  "out_photo_id" text,
  "remark" text,
  "marked_by_id" text,
  "marked_by_name" text,
  "report_to_stamp" text,
  "edit_help" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hrms_attendance_day_key" ON "hrms_attendance" ("employee_id", "date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_attendance_date_idx" ON "hrms_attendance" ("date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_leave_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "req_no" text NOT NULL,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "office_name" text,
  "applied_on" date NOT NULL,
  "type" text NOT NULL,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "days" numeric(5, 2) NOT NULL,
  "reason" text,
  "status" text DEFAULT 'Requesting' NOT NULL,
  "paid" numeric(5, 2),
  "unpaid" numeric(5, 2),
  "approved_by_name" text,
  "approved_by_id" text,
  "approved_on" date,
  "officer_remark" text,
  "status_at" timestamp with time zone,
  "lat" double precision,
  "lng" double precision,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hrms_leave_requests_no_key" ON "hrms_leave_requests" ("req_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_leave_requests_emp_idx" ON "hrms_leave_requests" ("employee_id", "start_date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_leave_credits" (
  "id" text PRIMARY KEY NOT NULL,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "month" text NOT NULL,
  "days" numeric(5, 2) NOT NULL,
  "source" text DEFAULT 'hand' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hrms_leave_credits_job_key" ON "hrms_leave_credits" ("employee_id", "month") WHERE "source" = 'job';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_leave_credits_emp_idx" ON "hrms_leave_credits" ("employee_id", "month");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_holidays" (
  "id" text PRIMARY KEY NOT NULL,
  "date" date NOT NULL,
  "category" text NOT NULL,
  "name" text NOT NULL,
  "tagged" text DEFAULT 'All employees' NOT NULL,
  "tagged_employee_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "remark" text,
  "created_by_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_holidays_date_idx" ON "hrms_holidays" ("date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_overtime" (
  "id" text PRIMARY KEY NOT NULL,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "date" date NOT NULL,
  "slot" text NOT NULL,
  "start_time" text NOT NULL,
  "end_time" text NOT NULL,
  "minutes" integer NOT NULL,
  "remark" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hrms_overtime_day_key" ON "hrms_overtime" ("employee_id", "date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_monthly_remarks" (
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "month" text NOT NULL,
  "remark" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text,
  CONSTRAINT "hrms_monthly_remarks_pk" PRIMARY KEY ("employee_id", "month")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_salaries" (
  "id" text PRIMARY KEY NOT NULL,
  "salary_no" text NOT NULL,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "month" text NOT NULL,
  "salary_date" date NOT NULL,
  "status" text DEFAULT 'Prepared' NOT NULL,
  "comp_days" numeric(5, 2) DEFAULT 0 NOT NULL,
  "incentive_paise" bigint DEFAULT 0 NOT NULL,
  "advance_deduction_paise" bigint DEFAULT 0 NOT NULL,
  "days_in_month" integer NOT NULL,
  "figures" jsonb NOT NULL,
  "in_hand_paise" bigint NOT NULL,
  "remark" text,
  "approved_by_name" text,
  "approved_by_id" text,
  "approved_at" timestamp with time zone,
  "prepared_by_name" text,
  "utr" text,
  "paid_on" date,
  "payslip_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hrms_salaries_month_key" ON "hrms_salaries" ("employee_id", "month");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hrms_salaries_no_key" ON "hrms_salaries" ("salary_no");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_advances" (
  "id" text PRIMARY KEY NOT NULL,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "date" date NOT NULL,
  "amount_paise" bigint NOT NULL,
  "remark" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_advances_emp_idx" ON "hrms_advances" ("employee_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_expenses" (
  "id" text PRIMARY KEY NOT NULL,
  "serial" text NOT NULL,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "date" date NOT NULL,
  "pay_type" text NOT NULL,
  "location" text,
  "category" text,
  "particular" text,
  "claim_paise" bigint,
  "paid_paise" bigint,
  "reason" text,
  "verify" text DEFAULT 'Pending' NOT NULL,
  "created_by_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hrms_expenses_serial_key" ON "hrms_expenses" ("serial");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_expenses_emp_idx" ON "hrms_expenses" ("employee_id", "date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_task_templates" (
  "id" text PRIMARY KEY NOT NULL,
  "serial" integer NOT NULL,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "task" text NOT NULL,
  "frequency" text NOT NULL,
  "weekdays" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "category" text,
  "day_of_month" integer,
  "before_day" integer,
  "start_time" text,
  "end_time" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_task_templates_emp_idx" ON "hrms_task_templates" ("employee_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_checklist" (
  "id" text PRIMARY KEY NOT NULL,
  "date" date NOT NULL,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "template_id" text,
  "task" text NOT NULL,
  "frequency" text,
  "weekday" text,
  "start_time" text,
  "end_time" text,
  "status" text DEFAULT '' NOT NULL,
  "working_time" text,
  "remark" text,
  "na_reason" text,
  "stamped_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_checklist_day_idx" ON "hrms_checklist" ("employee_id", "date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_todos" (
  "id" text PRIMARY KEY NOT NULL,
  "for_date" date NOT NULL,
  "till_date" date,
  "from_employee_id" text,
  "from_label" text NOT NULL,
  "to_employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "category" text,
  "task" text NOT NULL,
  "urgent" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'Open' NOT NULL,
  "recheck" text DEFAULT '' NOT NULL,
  "remark" text,
  "done_at" timestamp with time zone,
  "done_on" date,
  "monthly_key" text,
  "template_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_todos_to_idx" ON "hrms_todos" ("to_employee_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_todos_from_idx" ON "hrms_todos" ("from_employee_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_buddy_tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "date" date NOT NULL,
  "from_employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "to_employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "task" text NOT NULL,
  "note" text,
  "status" text DEFAULT 'Shared' NOT NULL,
  "accepted_at" timestamp with time zone,
  "done_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_buddy_tasks_to_idx" ON "hrms_buddy_tasks" ("to_employee_id", "date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_kpi" (
  "id" text PRIMARY KEY NOT NULL,
  "date" date NOT NULL,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "area" text,
  "visits" integer DEFAULT 0 NOT NULL,
  "productive" integer DEFAULT 0 NOT NULL,
  "litres" numeric(12, 2) DEFAULT 0 NOT NULL,
  "km" numeric(10, 2) DEFAULT 0 NOT NULL,
  "amount_paise" bigint DEFAULT 0 NOT NULL,
  "outstanding_paise" bigint DEFAULT 0 NOT NULL,
  "stoppage_min" integer DEFAULT 0 NOT NULL,
  "time_given_min" integer DEFAULT 0 NOT NULL,
  "notes" text,
  "prefill" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hrms_kpi_day_key" ON "hrms_kpi" ("employee_id", "date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_reviews" (
  "id" text PRIMARY KEY NOT NULL,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "from_date" date NOT NULL,
  "to_date" date NOT NULL,
  "issues" text,
  "ideas" text,
  "next_plan" text,
  "action_for_sir" text,
  "pdf_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hrms_reviews_period_key" ON "hrms_reviews" ("employee_id", "from_date", "to_date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_calling" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "date" date NOT NULL,
  "status" text DEFAULT '' NOT NULL,
  "second_status" text,
  "note" text,
  "follow_up" date,
  "misses" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_calling_emp_idx" ON "hrms_calling" ("employee_id", "date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_calling_customer_idx" ON "hrms_calling" ("customer_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_activities" (
  "id" text PRIMARY KEY NOT NULL,
  "date" date NOT NULL,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "customer_id" text REFERENCES "customers"("id") ON DELETE SET NULL,
  "customer_name" text,
  "note" text,
  "minutes" integer DEFAULT 0 NOT NULL,
  "mood" text,
  "issue" text,
  "reminder" date,
  "meet_type" text,
  "purpose" text,
  "area" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_activities_emp_idx" ON "hrms_activities" ("employee_id", "date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_journeys" (
  "id" text PRIMARY KEY NOT NULL,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "location" text,
  "plan" text,
  "customer_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "remark" text,
  "file_attachment_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_journeys_emp_idx" ON "hrms_journeys" ("employee_id", "start_date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_asset_stock" (
  "id" text PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "purchase_date" date NOT NULL,
  "name" text NOT NULL,
  "category" text NOT NULL,
  "cost_paise" bigint DEFAULT 0 NOT NULL,
  "qty" integer NOT NULL,
  "office_name" text,
  "description" text,
  "warranty_till" date,
  "invoice_attachment_id" text,
  "image_attachment_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hrms_asset_stock_code_key" ON "hrms_asset_stock" ("code");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_asset_assignments" (
  "id" text PRIMARY KEY NOT NULL,
  "stock_id" text NOT NULL REFERENCES "hrms_asset_stock"("id") ON DELETE CASCADE,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "from_name" text,
  "qty" integer NOT NULL,
  "date" date NOT NULL,
  "responsibility" text,
  "photo1_id" text,
  "photo2_id" text,
  "status" text DEFAULT 'Assigned' NOT NULL,
  "restored_on" date,
  "restored_by" text,
  "restored_qty" integer,
  "restored_remark" text,
  "restored_photo_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_asset_assignments_emp_idx" ON "hrms_asset_assignments" ("employee_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_asset_assignments_stock_idx" ON "hrms_asset_assignments" ("stock_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_help" (
  "id" text PRIMARY KEY NOT NULL,
  "date" date NOT NULL,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "in_time" text,
  "out_time" text,
  "text" text,
  "status" text DEFAULT 'Pending' NOT NULL,
  "admin_remark" text,
  "decided_at" timestamp with time zone,
  "decided_by_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hrms_help_emp_idx" ON "hrms_help" ("employee_id", "date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_grievances" (
  "id" text PRIMARY KEY NOT NULL,
  "no" integer NOT NULL,
  "date" date NOT NULL,
  "by_employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "to_label" text NOT NULL,
  "to_employee_id" text,
  "issue" text NOT NULL,
  "status" text DEFAULT 'Pending' NOT NULL,
  "solution" text,
  "solved_by_id" text,
  "stars" integer,
  "feedback_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hrms_grievances_no_key" ON "hrms_grievances" ("no");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_documents" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "type" text NOT NULL,
  "file_attachment_id" text,
  "url" text,
  "description" text,
  "date" date NOT NULL,
  "tagged" text DEFAULT 'All employees' NOT NULL,
  "tagged_employee_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_notifications" (
  "id" text PRIMARY KEY NOT NULL,
  "from_employee_id" text,
  "from_name" text NOT NULL,
  "to_employee_id" text,
  "to_label" text NOT NULL,
  "text" text NOT NULL,
  "landing" text,
  "seen_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_ref_lists" (
  "list" text PRIMARY KEY NOT NULL,
  "values" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id" text
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_user_powers" (
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "power" text NOT NULL,
  "granted_by_id" text REFERENCES "users"("id"),
  "granted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "hrms_user_powers_pk" PRIMARY KEY ("user_id", "power")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hrms_series" (
  "key" text PRIMARY KEY NOT NULL,
  "last" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint

-- Series start past whatever the sheet already used, so a new employee's
-- code never repeats one the source handed out at random.
INSERT INTO "hrms_series" ("key", "last")
SELECT 'employee', coalesce(max(nullif(regexp_replace("employee_code", '\D', '', 'g'), '')::int), 1000) FROM "employees"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "hrms_series" ("key", "last") VALUES ('leave', 0), ('salary', 0), ('expense', 0), ('grievance', 10000), ('template', 0), ('asset', 0)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- The offices people already belong to, so a check-in has something to
-- compare against on day one. Each still needs its map pin set on the
-- Offices screen: without one, check-in says so rather than guessing.
INSERT INTO "hrms_offices" ("id", "name")
SELECT 'hof_' || substr(md5("office_name"), 1, 16), "office_name"
  FROM (SELECT DISTINCT trim("office_name") AS "office_name" FROM "employees" WHERE coalesce(trim("office_name"), '') <> '') o
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- The value lists the source kept open (spec §3), seeded with its values.
INSERT INTO "hrms_ref_lists" ("list", "values") VALUES
  ('Bank names', '[]'::jsonb),
  ('Position types', '["Sales","OfficeStaff","Other"]'::jsonb),
  ('Positions', '["Sales State Head","Sales Executives Level3","Sales Executives Level 2","Sales Executives Level1","Ambernath Office","Production Head","DeliveryStaff"]'::jsonb),
  ('Areas', '[]'::jsonb),
  ('Holiday categories', '["Festival","Weekly","National","Nature"]'::jsonb),
  ('Holiday names', '[]'::jsonb),
  ('Expense categories', '["Local Travel","Travel","Hotel Stay","Stationary","Food","Extra"]'::jsonb),
  ('Expense particulars', '[]'::jsonb),
  ('Expense locations', '[]'::jsonb),
  ('Customer segmentation', '[]'::jsonb),
  ('States', '[]'::jsonb),
  ('Activity issues', '[]'::jsonb),
  ('Moods', '["Happy","Normal"]'::jsonb),
  ('Meeting types', '[]'::jsonb),
  ('Meeting purposes', '[]'::jsonb),
  ('Journey locations', '[]'::jsonb),
  ('Asset names', '["Visiting Card"]'::jsonb),
  ('Task categories', '["Urgent and Important","Important","To-Do Only"]'::jsonb),
  ('To-do categories', '["Urgent and Important","Important","To-Do Only"]'::jsonb)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Banks, positions and areas already typed on the employee sheet.
UPDATE "hrms_ref_lists" SET "values" = (SELECT coalesce(jsonb_agg(DISTINCT trim("bank_name")), '[]'::jsonb) FROM "employees" WHERE coalesce(trim("bank_name"), '') <> '')
 WHERE "list" = 'Bank names';
--> statement-breakpoint
UPDATE "hrms_ref_lists" SET "values" = (SELECT coalesce(jsonb_agg(DISTINCT trim("area_allocated")), '[]'::jsonb) FROM "employees" WHERE coalesce(trim("area_allocated"), '') <> '')
 WHERE "list" = 'Areas';
