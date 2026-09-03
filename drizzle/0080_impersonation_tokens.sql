-- IF NOT EXISTS / DO-block guards throughout this and the five migrations
-- after it (0081-0085): production had this schema already, applied by a
-- `drizzle-kit push` run before any of these six ever reached `migrate`, so
-- the plain CREATE/ALTER this migration shipped with hard-failed with
-- "already exists" the first time `migrate` actually ran it — after which,
-- because every pending migration in a batch shares one transaction, nothing
-- from 0080 onward could ever apply, migration or not. See
-- scripts/migrate-deploy.mjs's own comment for how that was diagnosed. Made
-- safe rather than reverted, because what is on production is already
-- structurally identical to what these create.
CREATE TABLE IF NOT EXISTS "impersonation_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_by_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "impersonation_tokens" ADD CONSTRAINT "impersonation_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "impersonation_tokens" ADD CONSTRAINT "impersonation_tokens_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "impersonation_tokens_token_key" ON "impersonation_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "impersonation_tokens_user_idx" ON "impersonation_tokens" USING btree ("user_id");
