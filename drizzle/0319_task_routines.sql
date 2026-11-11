-- Routines: a task that comes back on a schedule. See the TASKS section of
-- src/db/schema.ts and lib/tasks/routines.ts.
--
-- Each day a routine falls due it writes one ordinary row of `tasks`, which
-- names the routine and the day it was for; the partial unique index on that
-- pair is what lets the hourly job, the nightly one and somebody opening the
-- app all ask for the same day without a second copy ever landing.
CREATE TABLE IF NOT EXISTS "task_routines" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"app" text DEFAULT 'tasks' NOT NULL,
	"assignee_id" text NOT NULL REFERENCES "users"("id"),
	"created_by_id" text NOT NULL REFERENCES "users"("id"),
	"priority" text DEFAULT 'normal' NOT NULL,
	"proof_required" boolean DEFAULT false NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"frequency" text NOT NULL,
	"weekdays" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"day_of_month" integer,
	"complete_by_day" integer,
	"start_time" text,
	"due_time" text,
	"active" boolean DEFAULT true NOT NULL,
	"starts_on" date NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_routines_frequency" CHECK ("frequency" in ('daily','weekly','monthly')),
	CONSTRAINT "task_routines_priority" CHECK ("priority" in ('urgent','high','normal','low')),
	CONSTRAINT "task_routines_times" CHECK (("start_time" is null or "start_time" ~ '^[0-2][0-9]:[0-5][0-9]$') and ("due_time" is null or "due_time" ~ '^[0-2][0-9]:[0-5][0-9]$')),
	CONSTRAINT "task_routines_days" CHECK (
		case when "frequency" = 'monthly'
			then "day_of_month" between 1 and 31
				and ("complete_by_day" is null or ("complete_by_day" > "day_of_month" and "complete_by_day" <= 31))
			else jsonb_array_length("weekdays") > 0 and "day_of_month" is null and "complete_by_day" is null
		end
	)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_routines_assignee_idx" ON "task_routines" ("assignee_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_routines_source_key" ON "task_routines" ("source") WHERE "source" is not null;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "routine_id" text REFERENCES "task_routines"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "routine_day" date;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_routine_day_key" ON "tasks" ("routine_id","routine_day") WHERE "routine_id" is not null;
