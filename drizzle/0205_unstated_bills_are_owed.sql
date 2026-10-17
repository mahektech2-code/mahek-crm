-- A bill nobody has spoken for is OWED from its credit-term due date (Mahek,
-- October 2026). Every sheet bill that landed `unstated` becomes `stated`, so
-- outstanding, aging and collections count it like any other. The one bill
-- left alone is one the Payment Status tab says was Received: that is a record
-- of the money arriving, not silence. `payment_decided_at` stays null — no
-- person decided this, and the receivables report may still restate it.
-- The cached figures (outstanding, follow-up stage, slow payer) are rebuilt by
-- the nightly pass, or at once with `npm run jobs -- nightly`.
UPDATE "bills" SET "payment_position" = 'stated', "updated_at" = now()
WHERE "payment_position" = 'unstated'
  AND NOT EXISTS (
    SELECT 1 FROM "sheet_payment_rows" sp
    WHERE sp."status" = 'present'
      AND lower(trim(sp."payment_status")) = 'received'
      AND "bills"."external_ref" = 'SHEETPAY-' || sp."order_number"
  );
