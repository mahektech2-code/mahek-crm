-- "Harsh Trasnport" was a typo for "Harsh Transport". Orders, bills, LRs,
-- trips, freight bills, returns and party defaults carried both spellings, so
-- one transporter read as two. Every text copy takes the right spelling.
--
-- The transporter list holds names unique without regard to case. Where only
-- the misspelt row exists it is renamed; where both do, the misspelt row's
-- godowns (and their people) move to the right one and the misspelt row is
-- switched off — never deleted, so nothing pointing at it is lost.
UPDATE "erp_customer_profiles" SET "transporter" = 'Harsh Transport' WHERE lower(btrim("transporter")) = 'harsh trasnport';--> statement-breakpoint
UPDATE "erp_orders" SET "transporter" = 'Harsh Transport' WHERE lower(btrim("transporter")) = 'harsh trasnport';--> statement-breakpoint
UPDATE "erp_transports" SET "transporter" = 'Harsh Transport' WHERE lower(btrim("transporter")) = 'harsh trasnport';--> statement-breakpoint
UPDATE "erp_lrs" SET "transporter" = 'Harsh Transport' WHERE lower(btrim("transporter")) = 'harsh trasnport';--> statement-breakpoint
UPDATE "erp_trips" SET "transporter" = 'Harsh Transport' WHERE lower(btrim("transporter")) = 'harsh trasnport';--> statement-breakpoint
UPDATE "erp_freight_bills" SET "transporter" = 'Harsh Transport' WHERE lower(btrim("transporter")) = 'harsh trasnport';--> statement-breakpoint
UPDATE "erp_return_outwards" SET "transporter" = 'Harsh Transport' WHERE lower(btrim("transporter")) = 'harsh trasnport';--> statement-breakpoint
UPDATE "erp_customer_returns" SET "transporter" = 'Harsh Transport' WHERE lower(btrim("transporter")) = 'harsh trasnport';--> statement-breakpoint
UPDATE "erp_transporter_godowns" g SET "transporter_id" = good.id
  FROM "erp_transporters" bad, "erp_transporters" good
 WHERE g.transporter_id = bad.id
   AND lower(btrim(bad.name)) = 'harsh trasnport'
   AND lower(btrim(good.name)) = 'harsh transport';--> statement-breakpoint
UPDATE "erp_transporters" bad SET "active" = false, "updated_at" = now()
 WHERE lower(btrim(bad.name)) = 'harsh trasnport'
   AND EXISTS (SELECT 1 FROM "erp_transporters" good WHERE lower(btrim(good.name)) = 'harsh transport');--> statement-breakpoint
UPDATE "erp_transporters" SET "name" = 'Harsh Transport', "updated_at" = now()
 WHERE lower(btrim("name")) = 'harsh trasnport'
   AND NOT EXISTS (SELECT 1 FROM "erp_transporters" good WHERE lower(btrim(good.name)) = 'harsh transport');
