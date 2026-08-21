-- The cash deposit — the salesman's half of a two-step answer.
--
-- Cash collected in a market is a real personal liability for the man carrying
-- it until it is in the bank, and MBOS has always asked him to photograph the
-- paying-in slip. It had nowhere to land: `payments.deposited`,
-- `depositedAt` and `depositProofId` existed on the handset and on no server,
-- so the sync item was refused and a salesman who had done exactly the right
-- thing was told it had not been accepted.
--
-- This is deliberately NOT a confirmation. `status` still moves to `confirmed`
-- only when the back office finds the money on the bank statement — the
-- deposit says it was paid in, the confirmation says it arrived, and every
-- money path in MahekOne keys on the second. Nothing about outstanding, aging,
-- the collections worklist or the slow-payer flag changes because of a column
-- here, which is why this migration moves no figure on any screen.
ALTER TABLE "payment_receipts"
  ADD COLUMN IF NOT EXISTS "deposited_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "deposited_by_id" text,
  ADD COLUMN IF NOT EXISTS "deposit_proof_id" text;

DO $$ BEGIN
  ALTER TABLE "payment_receipts"
    ADD CONSTRAINT "payment_receipts_deposited_by_id_users_id_fk"
    FOREIGN KEY ("deposited_by_id") REFERENCES "public"."users"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_receipts"
    ADD CONSTRAINT "payment_receipts_deposit_proof_id_attachments_id_fk"
    FOREIGN KEY ("deposit_proof_id") REFERENCES "public"."attachments"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
