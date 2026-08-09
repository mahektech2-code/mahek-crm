-- Proof of payment: a transfer screenshot, a cheque, a deposit slip.
--
-- Its own migration on purpose. Postgres refuses to USE a value added to an
-- enum until the transaction that added it commits, and drizzle-kit applies
-- every pending migration in ONE transaction — so this value has to land in a
-- file of its own, ahead of anything that writes it.
ALTER TYPE "public"."attachment_parent" ADD VALUE 'payment_receipt';
