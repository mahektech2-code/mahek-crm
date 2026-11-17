-- A PERSON IS AN ID; A NAME IS A LABEL (owner's rule, 2026-11-18).
--
-- Each of these rows says "this person did / holds / controls this", and each
-- said it only as typed text — so an HRMS rename changed what the row meant,
-- and a check like "does this person already hold an open advance" was a
-- comparison of strings. Each gets the person's account id beside the text.
-- The text stays: it is what was written on the day, the label shown where
-- nobody could be matched, and (for the Locker) the name of a holder who is
-- not on the staff at all.
--
-- Nothing is filled here. A name becomes an id only through the person
-- directory, which knows every spelling a person has carried and refuses a
-- name two people share — SQL cannot ask it. Run
--   npm run jobs -- person-ids-backfill --dry-run
-- and then without the flag.
ALTER TABLE "erp_advances" ADD COLUMN IF NOT EXISTS "user_id" text REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_advances_user_open_idx" ON "erp_advances" ("user_id") WHERE "status" = 'open';
--> statement-breakpoint
ALTER TABLE "erp_credits" ADD COLUMN IF NOT EXISTS "user_id" text REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "erp_expenses" ADD COLUMN IF NOT EXISTS "expense_by_id" text REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "salesman_id" text REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "erp_requests" ADD COLUMN IF NOT EXISTS "salesman_id" text REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "locker_identities" ADD COLUMN IF NOT EXISTS "controlled_by_id" text REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locker_identities_controlled_by_idx" ON "locker_identities" ("controlled_by_id") WHERE "controlled_by_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "locker_payment_methods" ADD COLUMN IF NOT EXISTS "holder_user_id" text REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locker_payment_methods_holder_user_idx" ON "locker_payment_methods" ("holder_user_id") WHERE "holder_user_id" IS NOT NULL;
