-- A started Locker renewal can be CANCELLED (abandoned): it is kept, with who
-- and why, and the asset goes back to its dates. A cancelled task is not open,
-- so the "one open renewal per asset" index now leaves it out as well.
ALTER TABLE "locker_renewals" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "locker_renewals" ADD COLUMN IF NOT EXISTS "cancelled_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "locker_renewals" ADD COLUMN IF NOT EXISTS "cancel_reason" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "locker_renewals_one_open";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "locker_renewals_one_open" ON "locker_renewals" ("asset_id") WHERE "completed_at" is null and "cancelled_at" is null;
