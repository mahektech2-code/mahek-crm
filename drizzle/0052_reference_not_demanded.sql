-- A reference is asked for, and no longer demanded.
--
-- The rule was that money asserted to be in the bank cannot be confirmed
-- without the string that finds it there again, and the reasoning was sound:
-- accounts match a receipt against the statement by the UTR or cheque number.
--
-- What it did in practice was refuse the save. Accounts sitting with the bank
-- statement open — having already cross-verified the very payment they were
-- entering — were stopped by a red line under a box, on money they could see.
-- A receipt nobody can record is worse in every way than one somebody has to
-- go looking for, and the entry itself is the cross-check the field was
-- standing in for.
--
-- The field stays, its guidance stays, and naming a mode here brings the old
-- rule back for that mode. It is simply empty to begin with.
--
-- Matching on `updated_by_id IS NULL` and on the value still being exactly the
-- previous default leaves a team that curated its own list completely alone.
UPDATE "app_settings"
   SET "value" = '[]'::jsonb
 WHERE "key" = 'payments.referenceRequiredModes'
   AND "updated_by_id" IS NULL
   AND "value" = '["Bank transfer","UPI","Cheque"]'::jsonb;
