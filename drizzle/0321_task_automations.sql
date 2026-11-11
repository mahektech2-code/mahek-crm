-- Automatic tasks: each app raises a task from its own records (a callback
-- promised, a payment reported, a PO waiting for approval…) and closes it when
-- the record no longer needs anybody. See lib/tasks/automations.ts.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "auto_rule" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "auto_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_auto_key" ON "tasks" ("auto_rule","auto_key") WHERE "auto_rule" is not null;--> statement-breakpoint
-- A rule closes its own task, so nobody's id is on it: the remark says why.
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_closed_with_remark";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_closed_with_remark" CHECK (("status" = 'done') = ("closed_at" is not null) and ("status" <> 'done' or ("close_remark" is not null and ("closed_by_id" is not null or "auto_rule" is not null))));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_automations" (
	"rule" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_by_id" text REFERENCES "users"("id"),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
