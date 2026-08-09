CREATE TYPE "public"."employment_status" AS ENUM('active', 'inactive', 'unknown');--> statement-breakpoint
ALTER TYPE "public"."app_id" ADD VALUE 'hrms' BEFORE 'admin';--> statement-breakpoint
CREATE TABLE "employees" (
	"id" text PRIMARY KEY NOT NULL,
	"sync_id" text,
	"row_number" integer NOT NULL,
	"employee_code" text NOT NULL,
	"name" text NOT NULL,
	"gender" text,
	"office_name" text,
	"reports_to" text,
	"department" text,
	"position" text,
	"area_allocated" text,
	"status" "employment_status" DEFAULT 'unknown' NOT NULL,
	"status_raw" text,
	"date_of_joining" date,
	"date_of_birth" date,
	"date_of_leaving" date,
	"marriage_anniversary" date,
	"child1_birthday" date,
	"child2_birthday" date,
	"email" text,
	"personal_mobile" text,
	"alternate_mobile" text,
	"company_mobile" text,
	"emergency_contact" text,
	"address" text,
	"permanent_address" text,
	"net_salary_paise" bigint,
	"conveyance_paise" bigint,
	"other_salary_paise" bigint,
	"monthly_paid_leave" integer,
	"yearly_maximum_leave" integer,
	"pf_esic_applicable" boolean,
	"uan_no" text,
	"esic_no" text,
	"bank_name" text,
	"ifsc_code" text,
	"account_number_last4" text,
	"aadhaar_last4" text,
	"pan_number" text,
	"photo_path" text,
	"raw" jsonb NOT NULL,
	"row_hash" text NOT NULL,
	"sheet_status" "sheet_row_status" DEFAULT 'present' NOT NULL,
	"last_seen_sync_id" text,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_sync_id_sheet_sync_runs_id_fk" FOREIGN KEY ("sync_id") REFERENCES "public"."sheet_sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_code_key" ON "employees" USING btree ("employee_code");--> statement-breakpoint
CREATE INDEX "employees_name_idx" ON "employees" USING btree ("name");--> statement-breakpoint
CREATE INDEX "employees_status_idx" ON "employees" USING btree ("status");--> statement-breakpoint
CREATE INDEX "employees_department_idx" ON "employees" USING btree ("department");--> statement-breakpoint
CREATE INDEX "employees_office_idx" ON "employees" USING btree ("office_name");--> statement-breakpoint
CREATE INDEX "employees_row_number_idx" ON "employees" USING btree ("row_number");