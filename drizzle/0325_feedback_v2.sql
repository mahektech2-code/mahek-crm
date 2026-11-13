-- Feedback v2: a number for every report (FB-1042), how much it is getting in
-- the way, who on the team is holding it, "same problem as" links, the
-- reporter's own answer to "is it fixed?", and team notes the reporter never
-- sees. See AGENTS.md, "Feedback is a conversation".
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "number" serial;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "feedback_number_key" ON "feedback" ("number");
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "impact" text;
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_impact_check"
  CHECK ("impact" is null or "impact" in ('blocking', 'slows', 'minor'));
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "assignee_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "duplicate_of_id" text REFERENCES "feedback"("id");
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_not_own_duplicate"
  CHECK ("duplicate_of_id" is null or "duplicate_of_id" <> "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_duplicate_idx" ON "feedback" ("duplicate_of_id");
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "verdict" text;
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_verdict_check"
  CHECK ("verdict" is null or "verdict" in ('fixed', 'still_happening'));
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "verdict_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "feedback_messages" ADD COLUMN IF NOT EXISTS "internal" boolean DEFAULT false NOT NULL;
