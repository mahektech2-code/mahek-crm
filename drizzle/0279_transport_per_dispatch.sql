-- A consignment is one DISPATCH, not one order number. erp_transports was
-- unique on order_no, so a line dispatch-verified on an order number that
-- already had a transport row -- an order copied in from the Taken Order
-- history with its old (often closed) row, or the second half of an order
-- shipped in two goes -- opened nothing, and never reached Logistics.
-- erp_order_details.transport_id says which consignment each line left on.
DROP INDEX IF EXISTS "erp_transports_order_key";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_transports_order_idx" ON "erp_transports" ("order_no");
--> statement-breakpoint
ALTER TABLE "erp_order_details" ADD COLUMN IF NOT EXISTS "transport_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_order_details_transport_idx" ON "erp_order_details" ("transport_id");
--> statement-breakpoint
-- The line that opened a row is its own id.
UPDATE "erp_order_details" d SET "transport_id" = t."id"
  FROM "erp_transports" t
 WHERE t."id" = d."order_id" AND d."transport_id" IS NULL;
--> statement-breakpoint
-- Its sibling lines dispatched the same day, on the same bill, left with it.
UPDATE "erp_order_details" d SET "transport_id" = t."id"
  FROM "erp_orders" o, "erp_transports" t
 WHERE o."id" = d."order_id" AND d."transport_id" IS NULL
   AND d."verification" = 'Verified'
   AND t."order_no" = o."order_no"
   AND t."bill_date" = d."dispatch_date"
   AND coalesce(t."bill_no", '') = coalesce(o."tally_bill_no", '');
