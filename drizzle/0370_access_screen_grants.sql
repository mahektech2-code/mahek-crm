-- Manage Access by position and screen. ADDITIVE: nothing reads these yet,
-- so nobody's access moves when this runs.
--
-- `app_access.position` is whose records somebody sees in that app —
-- associate (own), manager (own and their HRMS team's), everyone (the whole
-- company). NULL means the grant has not been converted yet.
--
-- `app_screen_access` is one row per person per screen they may open, with
-- the two ticks given on purpose: Edit, and Delete (which needs Edit).
-- `edit_by_delete` marks an Edit that Delete brought along, so unticking
-- Delete takes back only that. Filled by `npm run jobs -- access-screens-backfill`.
DO $$ BEGIN
  CREATE TYPE "access_position" AS ENUM ('associate', 'manager', 'everyone');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "app_access" ADD COLUMN IF NOT EXISTS "position" "access_position";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_screen_access" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "app" "app_id" NOT NULL,
  "screen" text NOT NULL,
  "can_edit" boolean DEFAULT false NOT NULL,
  "can_delete" boolean DEFAULT false NOT NULL,
  "edit_by_delete" boolean DEFAULT false NOT NULL,
  "granted_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "app_screen_access_delete_needs_edit" CHECK (NOT "can_delete" OR "can_edit")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_screen_access_user_screen_key" ON "app_screen_access" ("user_id", "screen");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_screen_access_user_app_idx" ON "app_screen_access" ("user_id", "app");
