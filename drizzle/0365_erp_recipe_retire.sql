-- A recipe can be RETIRED as a whole, and restored.
--
-- A recipe is the set of `erp_recipes` lines of one SFG product (there is no
-- header row), so retiring stamps every line of that product. A retired
-- recipe stops prefilling new SFG batches, stops flagging batch lines that
-- used more than it, leaves the Factory phones' batch sheets (no new mixing
-- batch of it can start) and leaves the MRP check — every reader filters on
-- `retired_at is null`. The batches already made to it keep their lines;
-- nothing here touches them. Restore clears the stamp.
ALTER TABLE "erp_recipes" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_recipes" ADD COLUMN IF NOT EXISTS "retired_by_id" text REFERENCES "users"("id");
