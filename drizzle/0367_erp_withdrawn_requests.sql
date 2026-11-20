-- A stock adjustment and an empty-drum correction can be WITHDRAWN by whoever
-- asked for it, while it is still pending: kept on the list, marked withdrawn,
-- rather than deleted or dressed up as somebody else's rejection.
ALTER TABLE "erp_stock_adjustments" DROP CONSTRAINT IF EXISTS "erp_stock_adjustments_status_check";
--> statement-breakpoint
ALTER TABLE "erp_stock_adjustments" ADD CONSTRAINT "erp_stock_adjustments_status_check" CHECK ("status" in ('pending', 'approved', 'rejected', 'withdrawn'));
--> statement-breakpoint
ALTER TABLE "erp_drum_adjustments" DROP CONSTRAINT IF EXISTS "erp_drum_adjustments_status_check";
--> statement-breakpoint
ALTER TABLE "erp_drum_adjustments" ADD CONSTRAINT "erp_drum_adjustments_status_check" CHECK ("status" in ('pending', 'approved', 'rejected', 'withdrawn'));
