-- HOLIDAY LEVELS (0228) — who a holiday is for.
--
-- A holiday was a date, a name and a free-text "where". It now carries a level
-- (company, state, district, city, area, named people), the places it covers
-- picked from `places`, and per-person allocations. Every existing row becomes
-- `company`, which is how the server's attendance verdict already read it, so
-- no day that was a holiday stops being one. Its typed "where" stays in
-- `scope`, and the Holidays screen says it was typed so somebody can choose.
ALTER TABLE "mbos_holidays" ADD COLUMN "level" text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "mbos_holidays" ADD COLUMN "category" text DEFAULT 'Festival' NOT NULL;--> statement-breakpoint
ALTER TABLE "mbos_holidays" ADD COLUMN "place_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mbos_holidays" ADD COLUMN "audience_label" text;--> statement-breakpoint
ALTER TABLE "mbos_holidays" ADD COLUMN "note" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mbos_holiday_assignments" (
  "id" text PRIMARY KEY NOT NULL,
  "holiday_id" text NOT NULL REFERENCES "mbos_holidays"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "mode" text NOT NULL CHECK ("mode" in ('include', 'exclude')),
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mbos_holiday_assignments_key" ON "mbos_holiday_assignments" ("holiday_id", "user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mbos_holiday_assignments_user_idx" ON "mbos_holiday_assignments" ("user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mbos_holiday_members" (
  "holiday_id" text NOT NULL REFERENCES "mbos_holidays"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "reason" text NOT NULL,
  CONSTRAINT "mbos_holiday_members_pk" PRIMARY KEY ("holiday_id", "user_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mbos_holiday_members_user_idx" ON "mbos_holiday_members" ("user_id");
