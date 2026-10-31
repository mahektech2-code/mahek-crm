-- UNDER PROCESS READS THE ORDERS. Every order line whose status is "Under
-- Process" (Orders → Production) comes into the day's plan by itself, as one
-- line per product: a loose SKU as loose-can preparation, a boxed SKU as
-- packing. Those lines are written by the plan's sync, never typed, so a
-- `source` says which kind a line is and `source_key` (category:item) is what
-- the sync finds it by. `order_refs` is the order numbers behind it.
ALTER TABLE "erp_production_plan_lines" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'manual';
--> statement-breakpoint
ALTER TABLE "erp_production_plan_lines" ADD COLUMN IF NOT EXISTS "source_key" text;
--> statement-breakpoint
ALTER TABLE "erp_production_plan_lines" ADD COLUMN IF NOT EXISTS "order_refs" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "erp_production_plan_lines" ADD CONSTRAINT "erp_production_plan_lines_source_check"
    CHECK ("source" in ('manual', 'order') AND ("source" = 'manual' OR "source_key" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_production_plan_lines_order_key" ON "erp_production_plan_lines" ("plan_id", "source_key") WHERE "source" = 'order';
