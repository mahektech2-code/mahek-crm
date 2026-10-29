-- WHO DECIDED THE PRICE ON AN ERP ORDER LINE, where the price list did not.
-- A typed rate used to replace the list rate with no record of who allowed it,
-- and a discount had no ceiling. The list rate at the time, who typed a
-- different one and when, and who authorised a discount above what an
-- associate may give alone. All nullable: every line written before reads as
-- it did.
ALTER TABLE "erp_orders" ADD COLUMN IF NOT EXISTS "list_rate_paise" bigint;
--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN IF NOT EXISTS "rate_set_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN IF NOT EXISTS "rate_set_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN IF NOT EXISTS "discount_authorised_by_id" text REFERENCES "users"("id");
