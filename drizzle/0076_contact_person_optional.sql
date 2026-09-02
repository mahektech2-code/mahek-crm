-- Not every account has one named contact — a shop counter often does not —
-- and the customer edit form was sending it as always-present, so an
-- existing record with a blank one could not be saved at all until somebody
-- typed a name in, even to fix an unrelated field like the phone number.
ALTER TABLE "customers" ALTER COLUMN "contact_person" DROP NOT NULL;
