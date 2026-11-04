-- The ERP's dispatch-verification badge asks for detail lines still unverified
-- on every navigation, and with no index it read all 22k detail lines to find
-- the one or two waiting. This holds only those. verification is text, not an
-- enum, so the literal is safe in a from-scratch migrate.
CREATE INDEX IF NOT EXISTS "erp_order_details_unverified_idx" ON "erp_order_details" ("order_id") WHERE "verification" IS NULL OR "verification" = 'Pending';
