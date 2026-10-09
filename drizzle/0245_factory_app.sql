-- The factory floor's phone app (src/app/factory). Everything it records as
-- stock goes through the ERP's own documents; these tables hold what the ERP
-- never had: assigned work, the team on it, machine stops, the review queue
-- and the idempotency ledger that makes a double tap post once.

ALTER TYPE "app_id" ADD VALUE IF NOT EXISTS 'factory';--> statement-breakpoint
ALTER TYPE "attachment_parent" ADD VALUE IF NOT EXISTS 'factory_task';--> statement-breakpoint

CREATE TABLE "factory_staff" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "area" text NOT NULL,
  "role_label" text,
  "badge_code" text UNIQUE,
  "pin_hash" text,
  "lang" text DEFAULT 'en' NOT NULL,
  "hr_confirmed" boolean DEFAULT true NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "factory_staff_area_check" CHECK ("area" in ('head', 'mixing', 'filling', 'packing', 'dispatch', 'qc')),
  CONSTRAINT "factory_staff_lang_check" CHECK ("lang" in ('en', 'hi', 'mr'))
);--> statement-breakpoint

CREATE TABLE "factory_team_defaults" (
  "proc" text NOT NULL,
  "role" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  CONSTRAINT "factory_team_defaults_pk" PRIMARY KEY ("proc", "role", "user_id"),
  CONSTRAINT "factory_team_defaults_proc_check" CHECK ("proc" in ('mixing', 'filling', 'packing', 'dispatch')),
  CONSTRAINT "factory_team_defaults_role_check" CHECK ("role" in ('owner', 'operator', 'helper', 'verifier'))
);--> statement-breakpoint

CREATE TABLE "factory_tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "proc" text NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "work_date" date NOT NULL,
  "due" text NOT NULL,
  "status" text DEFAULT 'ready' NOT NULL,
  "item" text,
  "batches" integer,
  "target" integer,
  "sfg_lot" text,
  "order_no" text,
  "out" jsonb,
  "done_at" timestamp with time zone,
  "created_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "factory_tasks_proc_check" CHECK ("proc" in ('mixing', 'filling', 'packing', 'dispatch')),
  CONSTRAINT "factory_tasks_status_check" CHECK ("status" in ('ready', 'done', 'cancelled'))
);--> statement-breakpoint
CREATE INDEX "factory_tasks_day_idx" ON "factory_tasks" ("godown_id", "work_date");--> statement-breakpoint
-- One open loading job per ERP order: the dispatch list is built from the
-- orders, and a second job for the same lorry is how it gets loaded twice.
CREATE UNIQUE INDEX "factory_tasks_order_key" ON "factory_tasks" ("order_no") WHERE "proc" = 'dispatch' AND "status" <> 'cancelled';--> statement-breakpoint

CREATE TABLE "factory_task_members" (
  "task_id" text NOT NULL REFERENCES "factory_tasks"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "role" text NOT NULL,
  "assigned_by_id" text REFERENCES "users"("id"),
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "factory_task_members_pk" PRIMARY KEY ("task_id", "user_id", "role"),
  CONSTRAINT "factory_task_members_role_check" CHECK ("role" in ('owner', 'operator', 'helper', 'verifier'))
);--> statement-breakpoint

CREATE TABLE "factory_submissions" (
  "key" text PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL REFERENCES "factory_tasks"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "payload" jsonb NOT NULL,
  "status" text DEFAULT 'processing' NOT NULL,
  "progress" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "result" jsonb,
  "attempts" integer DEFAULT 1 NOT NULL,
  "saved_at" text,
  "app_build" text,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "factory_submissions_status_check" CHECK ("status" in ('processing', 'done', 'failed', 'held'))
);--> statement-breakpoint
CREATE INDEX "factory_submissions_task_idx" ON "factory_submissions" ("task_id");--> statement-breakpoint

CREATE TABLE "factory_reviews" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "task_id" text NOT NULL REFERENCES "factory_tasks"("id"),
  "title" text NOT NULL,
  "body" text NOT NULL,
  "meta" text NOT NULL,
  "change" jsonb,
  "status" text DEFAULT 'open' NOT NULL,
  "decision" text,
  "reason" text,
  "decided_by_id" text REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "created_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "factory_reviews_kind_check" CHECK ("kind" in ('tolerance', 'manual', 'correction', 'attribution', 'issue', 'unposted')),
  CONSTRAINT "factory_reviews_status_check" CHECK ("status" in ('open', 'closed'))
);--> statement-breakpoint
CREATE INDEX "factory_reviews_open_idx" ON "factory_reviews" ("status");--> statement-breakpoint

CREATE TABLE "factory_downtime" (
  "id" text PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL REFERENCES "factory_tasks"("id"),
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "proc" text NOT NULL,
  "reason" text NOT NULL,
  "minutes" integer NOT NULL,
  "recorded_by_id" text REFERENCES "users"("id"),
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "factory_downtime_minutes_check" CHECK ("minutes" > 0)
);--> statement-breakpoint
CREATE INDEX "factory_downtime_at_idx" ON "factory_downtime" ("godown_id", "recorded_at");--> statement-breakpoint

-- Task numbers run T-1001, T-1002 … through the ERP's own series table.
INSERT INTO "erp_series" ("key", "last") VALUES ('factoryTask', 1000) ON CONFLICT DO NOTHING;
