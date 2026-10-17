-- The requirement's own quotation step is gone: supplier rates live on the
-- Quotation manager and every requirement is bought direct. "Buyer decision"
-- only ever chose between direct purchase and quotation, so its power is
-- retired. The quotation tables and the requisition's method columns are kept
-- as the record they are; nothing reads or writes them any more.
DELETE FROM "erp_user_powers" WHERE "power" = 'purchaseBuyer';
--> statement-breakpoint
DELETE FROM "erp_designation_powers" WHERE "power" = 'purchaseBuyer';
