-- The visit an order or a receipt was taken on, as the handset names it.
-- Plain text rather than a foreign key: the handset mints the visit id at the
-- shop door, and the order or the receipt routinely reaches the office before
-- the visit does. handleVisit reads these to fill mbos_visits.linked_* once the
-- visit lands, so the link is made whichever record arrives first.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "visit_id" text;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD COLUMN IF NOT EXISTS "visit_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_visit_idx" ON "orders" ("visit_id") WHERE "visit_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_receipts_visit_idx" ON "payment_receipts" ("visit_id") WHERE "visit_id" IS NOT NULL;
