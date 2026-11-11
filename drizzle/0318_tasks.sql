-- The Tasks app: every task a person has, from every app, in one place — and
-- each app's own "My tasks". See the TASKS section of src/db/schema.ts.
--
-- The two enum values are only declared here, never used: drizzle-kit applies
-- every pending migration in one transaction, and Postgres refuses to use a
-- value in the transaction that added it. Tasks is granted on the Access
-- screen or with `npm run app:grant -- tasks <email>`.
ALTER TYPE "public"."app_id" ADD VALUE IF NOT EXISTS 'tasks';--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE IF NOT EXISTS 'task';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"app" text NOT NULL,
	"given_by_id" text NOT NULL REFERENCES "users"("id"),
	"audience" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"app" text DEFAULT 'tasks' NOT NULL,
	"customer_id" text REFERENCES "customers"("id") ON DELETE SET NULL,
	"assignee_id" text NOT NULL REFERENCES "users"("id"),
	"created_by_id" text NOT NULL REFERENCES "users"("id"),
	"batch_id" text REFERENCES "task_batches"("id") ON DELETE SET NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"due_date" date NOT NULL,
	"due_time" text,
	"proof_required" boolean DEFAULT false NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_id" text REFERENCES "users"("id"),
	"close_remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_status" CHECK ("status" in ('todo','doing','waiting','done')),
	CONSTRAINT "tasks_priority" CHECK ("priority" in ('urgent','high','normal','low')),
	CONSTRAINT "tasks_due_time" CHECK ("due_time" is null or "due_time" ~ '^[0-2][0-9]:[0-5][0-9]$'),
	CONSTRAINT "tasks_closed_with_remark" CHECK (("status" = 'done') = ("closed_at" is not null) and ("status" <> 'done' or ("closed_by_id" is not null and "close_remark" is not null)))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_assignee_idx" ON "tasks" ("assignee_id","status","due_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_created_by_idx" ON "tasks" ("created_by_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_batch_idx" ON "tasks" ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_customer_idx" ON "tasks" ("customer_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_events" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
	"actor_id" text REFERENCES "users"("id"),
	"kind" text NOT NULL,
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_events_task_idx" ON "task_events" ("task_id","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
	"from_id" text NOT NULL REFERENCES "users"("id"),
	"to_id" text NOT NULL REFERENCES "users"("id"),
	"requested_by_id" text NOT NULL REFERENCES "users"("id"),
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_id" text REFERENCES "users"("id"),
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "task_transfers_status" CHECK ("status" in ('pending','accepted','rejected','withdrawn','moved')),
	CONSTRAINT "task_transfers_rejection_says_why" CHECK ("status" <> 'rejected' or "decision_note" is not null),
	CONSTRAINT "task_transfers_not_to_self" CHECK ("from_id" <> "to_id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_transfers_one_pending" ON "task_transfers" ("task_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_transfers_to_idx" ON "task_transfers" ("to_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_transfers_from_idx" ON "task_transfers" ("from_id","status");
