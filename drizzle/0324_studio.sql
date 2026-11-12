-- Studio: personalised festival and promotional posters for leads and
-- customers, ported from the standalone mahek-promotional-studio. See the
-- STUDIO section of src/db/schema.ts and of AGENTS.md.
--
-- A poster is stored as its RECIPE (design version, language, wording, the
-- recipient as it stood), never as pixels: design versions are immutable, so
-- the row redraws the same picture whenever it is opened.
--
-- The app_id value is only declared here, never used: drizzle-kit applies
-- every pending migration in one transaction, and Postgres refuses to use a
-- value in the transaction that added it. Studio is granted on the Access
-- screen or with `npm run app:grant -- studio <email>`.
ALTER TYPE "public"."app_id" ADD VALUE IF NOT EXISTS 'studio';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "studio_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"created_by_id" text NOT NULL REFERENCES "users"("id"),
	"audience" text NOT NULL,
	"template_id" text NOT NULL,
	"template_version" text NOT NULL,
	"template_name" text NOT NULL,
	"language" text NOT NULL,
	"variant_id" text,
	"show_product" boolean DEFAULT true NOT NULL,
	"requested" integer NOT NULL,
	"skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_batches_audience" CHECK ("audience" in ('lead','customer'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_batches_created_by_idx" ON "studio_batches" ("created_by_id","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "studio_posters" (
	"id" text PRIMARY KEY NOT NULL,
	"created_by_id" text NOT NULL REFERENCES "users"("id"),
	"customer_id" text REFERENCES "customers"("id") ON DELETE SET NULL,
	"audience" text NOT NULL,
	"recipient" jsonb NOT NULL,
	"sender_name" text,
	"template_id" text NOT NULL,
	"template_version" text NOT NULL,
	"template_name" text NOT NULL,
	"occasion" text NOT NULL,
	"language" text NOT NULL,
	"variant_id" text,
	"wording_label" text,
	"show_product" boolean DEFAULT true NOT NULL,
	"personal" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"batch_id" text REFERENCES "studio_batches"("id") ON DELETE CASCADE,
	"share_count" integer DEFAULT 0 NOT NULL,
	"last_shared_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_posters_audience" CHECK ("audience" in ('lead','customer'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_posters_created_by_idx" ON "studio_posters" ("created_by_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_posters_customer_idx" ON "studio_posters" ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_posters_batch_idx" ON "studio_posters" ("batch_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "studio_poster_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"poster_id" text NOT NULL REFERENCES "studio_posters"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "users"("id"),
	"channel" text NOT NULL,
	"format" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_poster_shares_channel" CHECK ("channel" in ('download','whatsapp','device'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_poster_shares_poster_idx" ON "studio_poster_shares" ("poster_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_poster_shares_user_idx" ON "studio_poster_shares" ("user_id","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "studio_designs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"canvas" text NOT NULL,
	"placement" jsonb NOT NULL,
	"manifest" jsonb,
	"copy" jsonb,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"background_ref" text NOT NULL,
	"preview_ref" text,
	"source_sha256" text NOT NULL,
	"created_by_id" text NOT NULL REFERENCES "users"("id"),
	"approved_by_id" text REFERENCES "users"("id"),
	"approved_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_designs_status" CHECK ("status" in ('draft','approved','archived')),
	CONSTRAINT "studio_designs_approved_has_manifest" CHECK ("status" = 'draft' or ("manifest" is not null and "preview_ref" is not null and "approved_at" is not null))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_designs_created_by_idx" ON "studio_designs" ("created_by_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_designs_status_idx" ON "studio_designs" ("status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "studio_people_dates" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"person_name" text NOT NULL,
	"company" text,
	"date" text NOT NULL,
	"note" text,
	"lead_days" integer DEFAULT 3 NOT NULL,
	"customer_id" text REFERENCES "customers"("id") ON DELETE SET NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_id" text NOT NULL REFERENCES "users"("id"),
	"updated_by_id" text NOT NULL REFERENCES "users"("id"),
	"deleted_by_id" text REFERENCES "users"("id"),
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_people_dates_kind" CHECK ("kind" in ('birthday','anniversary')),
	CONSTRAINT "studio_people_dates_lead_days" CHECK ("lead_days" in (1,3,7))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_people_dates_live_idx" ON "studio_people_dates" ("deleted_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "studio_reminder_state" (
	"user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"state" jsonb DEFAULT '{"read":{},"dismissed":{}}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
