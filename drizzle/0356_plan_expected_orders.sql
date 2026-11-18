-- UNDER PROCESS: EXPECTED ORDERS. A base (SFG) line started ahead for orders
-- not approved yet is marked, so the plan and the printed sheet say what it
-- is for; and each print keeps the expected box it carried, so a reprint of
-- Print 1 tomorrow is the sheet that was handed out. Additive only.

ALTER TABLE "erp_production_plan_lines" ADD COLUMN IF NOT EXISTS "for_expected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "erp_production_plan_prints" ADD COLUMN IF NOT EXISTS "expected" jsonb;
