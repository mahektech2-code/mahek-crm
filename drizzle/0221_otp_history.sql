-- The OTP history on the Admin Console: where each request came from, what
-- was typed, which provider carried it and what it answered, every check of
-- the code, and requests refused before anything was sent. Null on every row
-- written before this, which the screen reads as "not recorded".
ALTER TABLE "auth_otps" ADD COLUMN IF NOT EXISTS "provider" text;--> statement-breakpoint
ALTER TABLE "auth_otps" ADD COLUMN IF NOT EXISTS "surface" text;--> statement-breakpoint
ALTER TABLE "auth_otps" ADD COLUMN IF NOT EXISTS "requested_with" text;--> statement-breakpoint
ALTER TABLE "auth_otps" ADD COLUMN IF NOT EXISTS "request_ip" text;--> statement-breakpoint
ALTER TABLE "auth_otps" ADD COLUMN IF NOT EXISTS "user_agent" text;--> statement-breakpoint
ALTER TABLE "auth_otps" ADD COLUMN IF NOT EXISTS "provider_ref" text;--> statement-breakpoint
ALTER TABLE "auth_otps" ADD COLUMN IF NOT EXISTS "provider_response" jsonb;--> statement-breakpoint
ALTER TABLE "auth_otps" ADD COLUMN IF NOT EXISTS "refused_reason" text;--> statement-breakpoint
ALTER TABLE "auth_otps" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_otps" ADD COLUMN IF NOT EXISTS "last_attempt_result" text;--> statement-breakpoint
-- Which provider the rows already here went through is in the code hash itself.
UPDATE "auth_otps" SET "provider" = CASE WHEN "code_hash" LIKE 'minimoth:%' THEN 'minimoth' ELSE 'wati' END WHERE "provider" IS NULL;--> statement-breakpoint
UPDATE "auth_otps" SET "provider_ref" = substr("code_hash", 10) WHERE "provider_ref" IS NULL AND "code_hash" LIKE 'minimoth:_%';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_otps_created_idx" ON "auth_otps" ("created_at" DESC);
