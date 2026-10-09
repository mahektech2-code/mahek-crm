-- Vendor payments go out on TUESDAY AND FRIDAY (Mahek, October 2026). The
-- setting shipped as Tuesday to Friday. Move a stored value only where nobody
-- chose it — `updated_by_id is null` and still the old default — so a team
-- that picked its own days is left alone. Payouts already planned for a
-- Wednesday or Thursday still to come move on the next sync
-- (`replannedPayOn`), unless a person put them there.
UPDATE "app_settings"
   SET "value" = '["Tuesday", "Friday"]'::jsonb
 WHERE "key" = 'payments.vendorPayoutDays'
   AND "updated_by_id" IS NULL
   AND "value" = '["Tuesday", "Wednesday", "Thursday", "Friday"]'::jsonb;
