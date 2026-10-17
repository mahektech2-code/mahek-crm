-- THE PO NUMBER COMES FROM THE QUOTATION MANAGER. Purchase it makes it from
-- the ERP's own PO series, and a requirement is linked to it by typing it on
-- the requirement; the ERP keeps a PO for it
-- (source quotation_manager, arriving Sent) so goods are received against it
-- exactly as before. engines/purchase-flow.ts states the rule.
ALTER TABLE "erp_purchase_orders" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'erp' NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_purchase_orders" ADD COLUMN IF NOT EXISTS "qm_po_no" text;
--> statement-breakpoint
ALTER TABLE "erp_purchase_orders" DROP CONSTRAINT IF EXISTS "erp_purchase_orders_source_check";
--> statement-breakpoint
ALTER TABLE "erp_purchase_orders" ADD CONSTRAINT "erp_purchase_orders_source_check" CHECK ("source" in ('erp', 'quotation_manager'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_purchase_orders_qm_po_no_key" ON "erp_purchase_orders" USING btree (upper("qm_po_no")) WHERE "qm_po_no" is not null;
--> statement-breakpoint
ALTER TABLE "erp_po_lines" ADD COLUMN IF NOT EXISTS "quote_row_id" text;
--> statement-breakpoint
ALTER TABLE "erp_po_lines" ADD COLUMN IF NOT EXISTS "quote_column_id" text;
--> statement-breakpoint
ALTER TABLE "erp_po_lines" ADD COLUMN IF NOT EXISTS "drums" integer;
