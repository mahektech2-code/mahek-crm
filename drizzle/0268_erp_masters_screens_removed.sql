-- Masters → My customers and Price lists are taken out of the ERP.
--
-- Only the DESIGNATION templates are cleaned. A person's own app_module_access
-- rows naming either screen are left exactly where they are: deleting a row
-- that was somebody's last ERP row would leave them with none, and no rows
-- means the WHOLE ERP. `REMOVED_MODULES` in lib/modules.ts reads those rows as
-- a narrowing that opens nothing, and the next save on the Access screen drops
-- them because it can no longer draw them.
DELETE FROM "erp_designation_modules" WHERE "module" IN ('erp.myCustomers', 'erp.priceLists');
--> statement-breakpoint
-- The Sales person's sentence named the screen it no longer has. Only where
-- nobody has reworded it.
UPDATE "erp_designations"
   SET "description" = 'Raises complaints and credit-note requests.'
 WHERE "id" = 'erpd_sales'
   AND "description" = 'Raises complaints and credit-note requests, and keeps their own customers up to date.';
