-- THE ORDER HUB, OPTION A (Nov 2026). "Back office" on the hub was Accounts, so
-- an order was checked by Accounts twice and by the Production Head twice. Now
-- Accounts approve the TO (that makes the order number) and the Production
-- Head's one check is the MRP check. This adds what that needs to store:
--
--  * a TO can be DECLINED by Accounts, with the reason, who and when;
--  * a TO remembers a POSSIBLE DUPLICATE (same billing and delivery party, same
--    items, same day) and, where the person punching it said it is a different
--    order, who said so and why;
--  * a hold can be kept off the customer's tracking page (`customer_visible`);
--  * the Accounts deadline covers TOs (`kind = 'to'`).
--
-- Nothing already stored moves: every hold stays visible, no TO is declined or
-- flagged, and the deadline kinds already in use keep their rows.

ALTER TABLE "erp_order_intakes" ADD COLUMN IF NOT EXISTS "decline_reason" text;
--> statement-breakpoint
ALTER TABLE "erp_order_intakes" ADD COLUMN IF NOT EXISTS "declined_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "erp_order_intakes" ADD COLUMN IF NOT EXISTS "declined_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_order_intakes" ADD COLUMN IF NOT EXISTS "duplicate_of_id" text REFERENCES "erp_order_intakes"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "erp_order_intakes" ADD COLUMN IF NOT EXISTS "duplicate_state" text;
--> statement-breakpoint
ALTER TABLE "erp_order_intakes" ADD COLUMN IF NOT EXISTS "duplicate_reason" text;
--> statement-breakpoint
ALTER TABLE "erp_order_intakes" ADD COLUMN IF NOT EXISTS "duplicate_decided_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "erp_order_intakes" ADD COLUMN IF NOT EXISTS "duplicate_decided_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_order_intakes" DROP CONSTRAINT IF EXISTS "erp_order_intakes_status_check";
--> statement-breakpoint
ALTER TABLE "erp_order_intakes" ADD CONSTRAINT "erp_order_intakes_status_check" CHECK ("status" in ('open','correction','hold','verified','cancelled','declined'));
--> statement-breakpoint
ALTER TABLE "erp_order_intakes" DROP CONSTRAINT IF EXISTS "erp_order_intakes_declined_has_reason";
--> statement-breakpoint
ALTER TABLE "erp_order_intakes" ADD CONSTRAINT "erp_order_intakes_declined_has_reason" CHECK ("status" <> 'declined' or length(btrim(coalesce("decline_reason", ''))) > 0);
--> statement-breakpoint
ALTER TABLE "erp_order_intakes" DROP CONSTRAINT IF EXISTS "erp_order_intakes_duplicate_state_check";
--> statement-breakpoint
ALTER TABLE "erp_order_intakes" ADD CONSTRAINT "erp_order_intakes_duplicate_state_check" CHECK ("duplicate_state" is null or ("duplicate_state" in ('possible','different') and "duplicate_of_id" is not null));
--> statement-breakpoint
ALTER TABLE "erp_order_intakes" DROP CONSTRAINT IF EXISTS "erp_order_intakes_different_has_reason";
--> statement-breakpoint
ALTER TABLE "erp_order_intakes" ADD CONSTRAINT "erp_order_intakes_different_has_reason" CHECK (coalesce("duplicate_state", '') <> 'different' or length(btrim(coalesce("duplicate_reason", ''))) > 0);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_order_intakes_dup_day_idx" ON "erp_order_intakes" ("billing_customer_id", "order_date");
--> statement-breakpoint
ALTER TABLE "erp_order_holds" ADD COLUMN IF NOT EXISTS "customer_visible" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "accounts_sla_breaches" DROP CONSTRAINT IF EXISTS "accounts_sla_breaches_kind_check";
--> statement-breakpoint
ALTER TABLE "accounts_sla_breaches" ADD CONSTRAINT "accounts_sla_breaches_kind_check" CHECK ("kind" IN ('order','payment','credit_note','order_change','to'));
