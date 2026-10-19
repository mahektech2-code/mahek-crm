-- A customer return may be raised against an order line that went out with no
-- lot allocated — every line copied in from the Taken Order history, and stock
-- dispatched before batch codes. Such a return names its order line and the
-- batch printed on the cans that came back, and no batch-code row.
ALTER TABLE "erp_customer_returns" ALTER COLUMN "batch_code_id" DROP NOT NULL;
