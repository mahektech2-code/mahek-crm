-- A routine task not done by its due time is MISSED: closed by nobody, at the deadline, and never closable afterwards.
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_status";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status" CHECK ("status" in ('todo','doing','waiting','done','missed'));--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_closed_with_remark";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_closed_with_remark" CHECK (("status" in ('done','missed')) = ("closed_at" is not null) and ("status" <> 'done' or ("close_remark" is not null and ("closed_by_id" is not null or "auto_rule" is not null))) and ("status" <> 'missed' or ("routine_id" is not null and "closed_by_id" is null and "close_remark" is not null)));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_routine_open_due_idx" ON "tasks" ("due_date") WHERE "routine_id" is not null and "status" <> 'done' and "status" <> 'missed';
