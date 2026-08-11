-- Whether anybody has SAID what a bill's payment position is.
--
-- `bill_status` is derived from `paid_amount`, so it cannot express "nobody has
-- told us" — a bill nobody has spoken for comes out `unpaid`, which is a claim
-- of debt. The Order Details tab states what was billed and never what was
-- received, so a projected bill carries no evidence either way, and the
-- importer used to resolve that by assuming settled and writing a confirmed
-- receipt for the full amount. That marked every customer's every bill paid on
-- the sheet's authority with no person behind it.
--
-- DEFAULT 'stated' is the load-bearing part: every row already in the table
-- keeps precisely the behaviour it had, so this migration moves no figure on
-- any screen. Only the projection writes 'unstated', and only on INSERT.
--
-- IF NOT EXISTS on both statements, following 0036: a deployment that has been
-- through a branch carrying this column must not fail its next db:deploy, and
-- a failed migration fails the build with it.
DO $$ BEGIN
  CREATE TYPE "bill_payment_position" AS ENUM ('stated', 'unstated');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "payment_position"
  "bill_payment_position" DEFAULT 'stated' NOT NULL;--> statement-breakpoint

-- Outstanding, aging, the collections worklist and the slow-payer flag all
-- filter on this, and they read the whole table. Partial, because 'stated' is
-- the overwhelming majority and it is the 'unstated' rows a query needs to find.
CREATE INDEX IF NOT EXISTS "bills_unstated_idx" ON "bills" USING btree ("customer_id")
  WHERE "payment_position" = 'unstated';
