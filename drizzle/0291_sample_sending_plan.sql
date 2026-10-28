-- SAMPLE / TRIAL STEP 1 ASKS WHEN AND HOW A SAMPLE IS TO BE SENT.
--
-- `planned_send_date` is the day somebody intends it to go and `sending_mode` is
-- `courier` or `hand_delivery`. Neither is an event: the sample is not approved,
-- dispatched or received by their being written, and `dispatched_at`,
-- `expected_delivery_date` and `received_at` keep their own meanings.
--
-- Both are NULL on every sample raised before the question existed and nothing
-- backfills them -- a date and a mode invented for an old sample would be an
-- answer nobody gave. Additive and idempotent; no existing row is touched.
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "planned_send_date" date;
--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "sending_mode" text;
