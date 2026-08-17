-- Who reports to whom: a person pointing at a person.
--
-- Its own table because `employees` is a MIRROR of the workbook, rewritten by
-- the sync on every change, and this is the first piece of employee data
-- MahekOne owns rather than reflects. A column would work today and break the
-- day somebody extended the sync's 44-name allow-list without noticing.
--
-- It could not have come from the sheet. `employees.reports_to` looks like the
-- answer and is not: 60 of 71 rows hold one of four POSITION titles and none
-- matches an employee name, so it says what kind of person somebody answers to
-- and never which one.
CREATE TABLE "employee_reporting" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"manager_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text
);
--> statement-breakpoint
ALTER TABLE "employee_reporting" ADD CONSTRAINT "employee_reporting_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_reporting" ADD CONSTRAINT "employee_reporting_manager_id_employees_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_reporting" ADD CONSTRAINT "employee_reporting_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_reporting" ADD CONSTRAINT "employee_reporting_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_reporting_employee_key" ON "employee_reporting" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "employee_reporting_manager_idx" ON "employee_reporting" USING btree ("manager_id");