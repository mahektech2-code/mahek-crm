-- THE ADMIN CONSOLE'S RECYCLE BIN AND USAGE (Nov 2026).
--
-- A removed file keeps where it was (removed_parent_*) and its bytes for
-- `attachments.removedRetentionDays`, so it can be put back; purged_at says
-- the bytes are gone and it cannot. A deleted HRMS announcement is kept with
-- deleted_at rather than deleted. integration_usage counts requests to each
-- outside service per day.
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "removed_parent_type" "attachment_parent";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "removed_parent_id" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "purged_at" timestamp with time zone;--> statement-breakpoint
-- Everything removed before this already had its bytes swept by the orphan
-- pass, so it is marked purged rather than offered back with nothing behind it.
UPDATE "attachments" SET "purged_at" = coalesce("removed_at", now()) WHERE "status" = 'removed' AND "purged_at" IS NULL;--> statement-breakpoint
ALTER TABLE "hrms_notifications" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hrms_notifications" ADD COLUMN IF NOT EXISTS "deleted_by_id" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_usage" (
  "provider" text NOT NULL,
  "day" date NOT NULL,
  "calls" integer DEFAULT 0 NOT NULL,
  "failures" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "integration_usage_provider_day_pk" PRIMARY KEY ("provider", "day")
);
