-- WHO HANDLED A REPLY, AND WHEN. `actioned` was a bare boolean: a reply marked
-- done said nothing about who decided it needed nothing more, which is the
-- first question a manager asks when a customer says nobody got back to them.
-- Nullable, and nothing is backfilled: a reply actioned before this column
-- existed was handled by somebody, and inventing who would be worse than
-- saying it was not recorded.
ALTER TABLE wa_replies ADD COLUMN IF NOT EXISTS actioned_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE wa_replies ADD COLUMN IF NOT EXISTS actioned_by_id text REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
-- The Replies tab reads a customer's replies newest first, and the payment
-- tracker asks "did they reply after this message" per row.
CREATE INDEX IF NOT EXISTS wa_replies_customer_received_idx
  ON wa_replies (customer_id, received_at DESC);
