-- A customer's monthly target can ask for a NUMBER OF SALES BILLS as well as
-- (or instead of) a rupee figure. Null is "no bill target", never zero, so
-- every target that already exists keeps meaning exactly what it meant.
ALTER TABLE "monthly_targets" ADD COLUMN IF NOT EXISTS "bill_target" integer;--> statement-breakpoint
ALTER TABLE "monthly_targets" DROP CONSTRAINT IF EXISTS "monthly_targets_bill_target_positive";--> statement-breakpoint
ALTER TABLE "monthly_targets" ADD CONSTRAINT "monthly_targets_bill_target_positive" CHECK ("bill_target" is null or "bill_target" > 0);
