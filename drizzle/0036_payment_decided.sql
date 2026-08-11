-- Production already has this column. It was applied there as
-- `0035_payment_decided` through PR #77, which shipped the lock ahead of the
-- field-sales work rather than waiting behind it — so prod carries the column
-- but has no record of THIS tag, and would run this file on the next deploy.
--
-- IF NOT EXISTS is what makes that a no-op instead of a failed migration, a
-- failed `db:deploy`, and a failed build taking the whole deploy down with it.
-- Both files are idempotent, so whichever reaches a given database first wins
-- and the second does nothing.
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "payment_decided_at" timestamp with time zone;