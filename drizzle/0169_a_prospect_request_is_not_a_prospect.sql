-- A REQUEST TO BE PUT FORWARD AS A PROSPECT IS NOT A PROSPECT.
--
-- The calling desk qualifies an online lead by phone, then ASKS for it to
-- become a Prospect. The sales manager verifies it, and only a successful
-- verification moves the rung. Until then the lead is still a Suspect -- there
-- is no stage for "requested", and adding one to the enum would put a rung on
-- every ladder and on every handset that knows nothing about it -- so the
-- pending question is stored BESIDE the stage.
--
--   NULL       no live request: never asked, or asked and answered
--   awaiting   with the sales manager
--   followup   the manager is holding it
--   returned   the manager sent it back to the desk
--
-- Every column is nullable with no default, so this rewrites nothing and no
-- existing lead changes: each one reads as "no request". Who asked, when, why
-- and in what words are kept after the answer as history.
--
-- Written to be re-run safely (IF NOT EXISTS / DROP ... IF EXISTS on the two
-- constraints this migration itself adds), like 0124-0127.

ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "prospect_request_state" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "prospect_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "prospect_requested_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "prospect_request_reason" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "prospect_request_note" text;
--> statement-breakpoint

ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_prospect_request_state_check";
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_prospect_request_state_check"
  CHECK ("prospect_request_state" IS NULL
      OR "prospect_request_state" IN ('awaiting', 'followup', 'returned'));
--> statement-breakpoint
ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_prospect_request_has_when";
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_prospect_request_has_when"
  CHECK ("prospect_request_state" IS NULL OR "prospect_requested_at" IS NOT NULL);
--> statement-breakpoint

-- PARTIAL: the overwhelming majority of the book has no request, and the two
-- questions asked of this column are "what is awaiting the manager" and "what
-- did the desk get back".
CREATE INDEX IF NOT EXISTS "customers_prospect_request_idx"
  ON "customers" ("prospect_request_state")
  WHERE "prospect_request_state" IS NOT NULL;
