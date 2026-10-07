-- TASKS THAT ASK FOR SOMETHING (0228) — ADDITIVE ONLY.
--
-- An assignment from the Sales Dashboard is now a row of its own, carrying the
-- form the field fills in; each salesman's task points back at it and holds his
-- answers. Every existing task keeps a null campaign and null answers, which
-- is exactly what it was: a sentence and a tick.
CREATE TABLE IF NOT EXISTS "mbos_task_campaigns" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "form" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "audience" jsonb,
  "audience_sentence" text,
  "priority" "mbos_task_priority" DEFAULT 'medium' NOT NULL,
  "due_date" date,
  "task_count" integer DEFAULT 0 NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "closed_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mbos_task_campaigns_created_idx" ON "mbos_task_campaigns" ("created_at");--> statement-breakpoint
ALTER TABLE "mbos_tasks" ADD COLUMN IF NOT EXISTS "campaign_id" text REFERENCES "mbos_task_campaigns"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "mbos_tasks" ADD COLUMN IF NOT EXISTS "responses" jsonb;--> statement-breakpoint
ALTER TABLE "mbos_tasks" ADD COLUMN IF NOT EXISTS "responded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mbos_tasks_campaign_idx" ON "mbos_tasks" ("campaign_id");
