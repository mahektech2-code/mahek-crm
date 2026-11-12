-- Tasks read one page at a time now (lib/tasks/list-service.ts), so every
-- list is a filtered, ordered, counted read rather than "everything this
-- person has". These are the indexes those reads lean on at tens of
-- thousands of tasks.
--
-- A person's open work, by the day it is due: My day, the lists' Open, Late,
-- Today and Upcoming tabs, the Board, the tray and every sidebar count.
CREATE INDEX IF NOT EXISTS "tasks_open_assignee_due_idx" ON "tasks" ("assignee_id", "due_date") WHERE "status" <> 'done';
--> statement-breakpoint
-- A person's finished work, newest first: the Done screen and "done today".
CREATE INDEX IF NOT EXISTS "tasks_done_assignee_closed_idx" ON "tasks" ("assignee_id", "closed_at" DESC) WHERE "status" = 'done';
--> statement-breakpoint
-- What somebody gave others, newest first: Assigned by me.
CREATE INDEX IF NOT EXISTS "tasks_created_by_created_idx" ON "tasks" ("created_by_id", "created_at" DESC);
--> statement-breakpoint
-- A search across a whole team's tasks.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_title_trgm_idx" ON "tasks" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
-- Groups somebody gave, newest first.
CREATE INDEX IF NOT EXISTS "task_batches_given_by_idx" ON "task_batches" ("given_by_id", "created_at" DESC);
--> statement-breakpoint
-- Transfers somebody asked for on another's behalf, and the decided history.
CREATE INDEX IF NOT EXISTS "task_transfers_requested_by_idx" ON "task_transfers" ("requested_by_id", "status");
