-- Who gets a task: include/exclude rules by person, team, designation,
-- department, app level or ERP designation (lib/tasks/audience.ts), and
-- whether closing needs a remark as well as whether it needs a screenshot.
--
-- A routine may now be for an AUDIENCE rather than one person, re-read on
-- every day it runs — so one routine writes a task per person per day, and the
-- once-a-day key moves from (routine, day) to (routine, person, day).
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "remark_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "task_routines" ADD COLUMN IF NOT EXISTS "remark_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "task_routines" ADD COLUMN IF NOT EXISTS "audience" jsonb;--> statement-breakpoint
ALTER TABLE "task_routines" ALTER COLUMN "assignee_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_routines" DROP CONSTRAINT IF EXISTS "task_routines_for_someone";--> statement-breakpoint
ALTER TABLE "task_routines" ADD CONSTRAINT "task_routines_for_someone" CHECK ("assignee_id" is not null or "audience" is not null);--> statement-breakpoint
ALTER TABLE "task_batches" ADD COLUMN IF NOT EXISTS "rules" jsonb;--> statement-breakpoint
DROP INDEX IF EXISTS "tasks_routine_day_key";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_routine_person_day_key" ON "tasks" ("routine_id","assignee_id","routine_day") WHERE "routine_id" is not null;
