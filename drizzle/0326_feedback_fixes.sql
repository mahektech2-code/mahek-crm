-- Fixing a report: what it needs, the GitHub issue it became, the pull
-- request that fixed it, and the build that carried the fix live.
CREATE TABLE IF NOT EXISTS "feedback_fixes" (
  "feedback_id" text PRIMARY KEY REFERENCES "feedback"("id") ON DELETE CASCADE,
  "need" text,
  "diagnosis" jsonb,
  "diagnosis_model" text,
  "diagnosed_at" timestamptz,
  "diagnosed_by_id" text REFERENCES "users"("id"),
  "need_decided_by_id" text REFERENCES "users"("id"),
  "issue_number" integer,
  "issue_url" text,
  "issue_created_at" timestamptz,
  "issue_created_by_id" text REFERENCES "users"("id"),
  "ai_fix_requested_at" timestamptz,
  "ai_fix_requested_by_id" text REFERENCES "users"("id"),
  "pr_number" integer,
  "pr_url" text,
  "pr_state" text,
  "pr_merged_sha" text,
  "pr_merged_at" timestamptz,
  "deployed_build" text,
  "deployed_at" timestamptz,
  "checked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "feedback_fixes_need_check" CHECK ("need" IS NULL OR "need" IN ('code_change','data_fix','setting','access','how_to','not_a_fault')),
  CONSTRAINT "feedback_fixes_pr_state_check" CHECK ("pr_state" IS NULL OR "pr_state" IN ('open','merged','closed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "feedback_fixes_issue_key" ON "feedback_fixes" ("issue_number") WHERE "issue_number" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "feedback_fixes_waiting_idx" ON "feedback_fixes" ("issue_number") WHERE "issue_number" IS NOT NULL AND "deployed_at" IS NULL;
