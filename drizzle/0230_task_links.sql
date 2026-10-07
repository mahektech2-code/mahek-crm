-- TASKS LINKED TO THE CUSTOMER RECORD, AND THE TASK AI (0230) — ADDITIVE ONLY.
--
-- A task's answer can now be written back to the record it is about, and a
-- task can complete itself when the record already says what it asked. Each
-- task keeps what happened to every linked answer, and HOW it was completed —
-- by the salesman, or from the record. An assignment keeps the description the
-- AI drafted it from and the last AI summary of its answers.
ALTER TABLE "mbos_tasks" ADD COLUMN IF NOT EXISTS "link_results" jsonb;--> statement-breakpoint
ALTER TABLE "mbos_tasks" ADD COLUMN IF NOT EXISTS "completed_via" text;--> statement-breakpoint
ALTER TABLE "mbos_task_campaigns" ADD COLUMN IF NOT EXISTS "ai_brief" text;--> statement-breakpoint
ALTER TABLE "mbos_task_campaigns" ADD COLUMN IF NOT EXISTS "ai_summary" text;--> statement-breakpoint
ALTER TABLE "mbos_task_campaigns" ADD COLUMN IF NOT EXISTS "ai_summary_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mbos_task_campaigns" ADD COLUMN IF NOT EXISTS "skipped_complete" integer DEFAULT 0 NOT NULL;
