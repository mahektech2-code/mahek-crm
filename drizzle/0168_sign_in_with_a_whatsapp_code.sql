-- One-time sign-in codes sent on WhatsApp: signing in on the web and on the
-- MBOS handset, changing a password, and resetting a forgotten one. Only a
-- salted hash of each code is stored.
-- `otp_channel` has been declared in schema.ts since the start and no migration
-- ever created it, so it exists in no database yet. Guarded, in case one has.
DO $$ BEGIN
 CREATE TYPE "public"."otp_channel" AS ENUM('sms', 'whatsapp');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_otps" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"purpose" text NOT NULL,
	"channel" "otp_channel" DEFAULT 'whatsapp' NOT NULL,
	"destination" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_otps_purpose_check" CHECK ("purpose" in ('login', 'password_change', 'password_reset'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_otps_user_purpose_idx" ON "auth_otps" USING btree ("user_id", "purpose", "created_at" DESC NULLS LAST);
