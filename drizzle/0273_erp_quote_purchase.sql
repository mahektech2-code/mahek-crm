-- THE QUOTATION MANAGER BUYS. A manager marks a rate Ready to buy (grey); the
-- team buys it with Purchase it, which records the drums and the PO number,
-- and the cell turns yellow and carries a note. The rule is
-- quoteStatusRefusal in lib/erp/engines/quotes.ts.
ALTER TABLE "erp_quote_cells" DROP CONSTRAINT IF EXISTS "erp_quote_cells_status_check";
--> statement-breakpoint
ALTER TABLE "erp_quote_cells" ADD CONSTRAINT "erp_quote_cells_status_check" CHECK ("status" is null or "status" in ('ready', 'po', 'cancel', 'pickup'));
--> statement-breakpoint
ALTER TABLE "erp_quote_cells" ADD COLUMN IF NOT EXISTS "drums" integer;
--> statement-breakpoint
ALTER TABLE "erp_quote_cells" ADD COLUMN IF NOT EXISTS "po_no" text;
--> statement-breakpoint
ALTER TABLE "erp_quote_cells" ADD COLUMN IF NOT EXISTS "po_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "erp_quote_cells" ADD COLUMN IF NOT EXISTS "po_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_quote_cells" ADD COLUMN IF NOT EXISTS "ready_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "erp_quote_cells" ADD COLUMN IF NOT EXISTS "ready_at" timestamp with time zone;
