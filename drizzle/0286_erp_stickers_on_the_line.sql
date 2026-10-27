-- Dispatch stickers go on before billing now, while the goods are under
-- process or ready, and the invoice check no longer gates them. A line has no
-- erp_order_details row until it is billed, so "the stickers are on" is
-- recorded on the order line itself. What was recorded on bills so far is
-- copied across, so no sticker already marked as on reads as missing.
ALTER TABLE "erp_orders" ADD COLUMN "stickers_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN "stickers_by_id" text REFERENCES "users"("id");--> statement-breakpoint
UPDATE "erp_orders" o SET "stickers_at" = d."stickers_at", "stickers_by_id" = d."stickers_by_id"
  FROM "erp_order_details" d
  WHERE d."order_id" = o."id" AND d."stickers_at" IS NOT NULL;
