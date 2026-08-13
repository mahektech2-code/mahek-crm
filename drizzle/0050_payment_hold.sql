-- Money accounts are in the middle of finding.
--
-- `reported` means nobody has looked at the claim yet, and the quiet it buys
-- the customer EXPIRES — otherwise anybody could take themselves off the
-- collections list for good by saying they had paid, and the account would
-- simply stop appearing. `held` is a named person in accounts saying "I am
-- looking for this in the bank statement, leave them alone until I have", and
-- its quiet does NOT expire. What replaces the expiry is visibility: the hold
-- ages in plain sight on accounts' own list, and only a person releases it.
--
-- It touches no money. Every money path in the app keys on `confirmed`, so
-- this status counts exactly as much as `reported` did — which is nothing —
-- and nothing else had to be taught about it.
--
-- NOTHING HERE USES THE NEW VALUE. Postgres refuses to let a value added to an
-- enum be used in the transaction that added it (55P04), and drizzle-kit
-- applies every pending migration in ONE transaction — the same rule
-- `0044_receipt_reversed` and `0039_orders_source_mbos` were written around.
-- Adding columns is not using it; a default, a check or a where clause would
-- be. There is no backfill: no existing receipt is on hold, because until now
-- there was no way to put one there.
ALTER TYPE "public"."receipt_status" ADD VALUE IF NOT EXISTS 'held' BEFORE 'confirmed';--> statement-breakpoint

-- Who parked it, when, and why. The reason is required by the action that
-- writes it: a hold takes the customer off collections entirely, and the
-- telecaller who was chasing them has to be able to answer when the customer
-- rings to ask why nobody has been in touch.
--
-- These stay on the row after the hold is resolved. A payment held nine days
-- and then rejected is a story somebody will have to account for, and clearing
-- the columns on decision would erase it.
ALTER TABLE "payment_receipts" ADD COLUMN "held_by_id" text;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD COLUMN "held_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD COLUMN "hold_reason" text;--> statement-breakpoint

ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_held_by_id_users_id_fk" FOREIGN KEY ("held_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
