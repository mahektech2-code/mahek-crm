-- ONE REQUIREMENT, MANY ITEMS (0236) — ADDITIVE ONLY.
--
-- A department raises one requirement with every item it needs, often a
-- hundred at once. Each item stays its own erp_requisitions row, because the
-- method, the quotations, the vendor and the PO line are decided per item;
-- what binds the lines raised together is the requirement number they share.
-- Rows from before this carry none and read as their own requirement.
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "req_no" integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_requisitions_req_no_idx" ON "erp_requisitions" ("req_no");
--> statement-breakpoint
INSERT INTO "erp_series" ("key", "last") VALUES ('requirement', 0) ON CONFLICT DO NOTHING;
