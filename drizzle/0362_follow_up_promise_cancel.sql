-- A payment promise can be CANCELLED, and cancelling is not deleting.
--
-- A promise is a collections attempt carrying a promised amount and date, and
-- the attempt is a fact about a call that happened: it stays. What cancelling
-- records is that the promise no longer stands (entered against the wrong
-- customer, or withdrawn by the customer), so the worklist stops treating it
-- as the live promise, "promises kept" stops judging it, and its chase
-- reminder is dismissed. Who, when and why sit beside it on the row, the same
-- way a dismissed reminder keeps its reason.
ALTER TABLE "follow_up_attempts" ADD COLUMN IF NOT EXISTS "promise_cancelled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "follow_up_attempts" ADD COLUMN IF NOT EXISTS "promise_cancelled_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "follow_up_attempts" ADD COLUMN IF NOT EXISTS "promise_cancel_reason" text;
