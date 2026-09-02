-- OTP sign-in: a work number and a code sent to it replaces the web
-- password. `users.password_hash` and everything built on it (MBOS handset
-- pairing, the reset-link flow the People screen already sends) is left
-- completely alone — only the web login screen changes.
--
-- Hand-written rather than generated — this repo's drizzle-kit meta
-- snapshots are stale enough that `generate` re-emits old migrations.
CREATE TYPE "public"."otp_channel" AS ENUM('sms', 'whatsapp');
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"channel" "otp_channel" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "otp_codes_user_created_idx" ON "otp_codes" USING btree ("user_id","created_at");
