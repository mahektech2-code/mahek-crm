-- Reading trials: Sarvam beside OpenAI on the same photograph, and how the two
-- compared. ADDITIVE ONLY: one new table, nothing existing is altered and no row
-- is inserted. Holds per-field verdicts and timings, never a value read.
CREATE TABLE IF NOT EXISTS "ai_read_trials" (
  "id" text PRIMARY KEY NOT NULL,
  "feature" text NOT NULL,
  "provider" text NOT NULL,
  "subject_id" text,
  "ok" boolean DEFAULT false NOT NULL,
  "ms" integer,
  "error" text,
  "fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_read_trials_feature_idx" ON "ai_read_trials" USING btree ("feature","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_read_trials_subject_idx" ON "ai_read_trials" USING btree ("feature","subject_id");
