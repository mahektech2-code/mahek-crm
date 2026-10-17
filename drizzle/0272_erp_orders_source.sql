-- Where an ERP order line was written: in the ERP, or copied in from the Taken
-- Order tab. The book (orders/bills) already holds every sheet order under its
-- own SHEET- key, so a copied line must never be projected into it again when
-- erp.orders.live is switched on. source_ref is the tab's line key, so the copy
-- can be re-run without duplicating a line.
ALTER TABLE "erp_orders" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'erp' NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN IF NOT EXISTS "source_ref" text;
--> statement-breakpoint
ALTER TABLE "erp_orders" DROP CONSTRAINT IF EXISTS "erp_orders_source_check";
--> statement-breakpoint
ALTER TABLE "erp_orders" ADD CONSTRAINT "erp_orders_source_check" CHECK ("source" in ('erp', 'sheet'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_orders_source_ref_key" ON "erp_orders" ("source_ref") WHERE "source_ref" is not null;
