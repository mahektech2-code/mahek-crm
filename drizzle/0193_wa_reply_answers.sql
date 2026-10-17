-- ANSWERING A CUSTOMER FROM MAHEKONE. A reply typed in the CRM's Replies tab
-- goes out from the business number as a WhatsApp session message, and the
-- answer is kept ON the reply it answers: what was said back, by whom, when,
-- and whether Wati took it. One answer per incoming message — when the
-- customer writes again, that is a new row with its own answer.
ALTER TABLE wa_replies ADD COLUMN IF NOT EXISTS answer_body text;
--> statement-breakpoint
ALTER TABLE wa_replies ADD COLUMN IF NOT EXISTS answered_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE wa_replies ADD COLUMN IF NOT EXISTS answered_by_id text REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
-- sent | failed. A failed answer keeps its words and its reason, so it can be
-- read and tried again rather than vanishing.
ALTER TABLE wa_replies ADD COLUMN IF NOT EXISTS answer_status text;
--> statement-breakpoint
ALTER TABLE wa_replies ADD COLUMN IF NOT EXISTS answer_failure text;
--> statement-breakpoint
-- The same answer in the message log, for a known customer — so it shows in
-- the Log, on the record and on the payment page like any other message, and
-- so its delivered and read ticks have a row to land on.
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS in_reply_to_id text REFERENCES wa_replies(id) ON DELETE SET NULL;
--> statement-breakpoint
-- Session messages come back on the webhook with WhatsApp's id and none of
-- ours, so the ticks are matched on it.
CREATE INDEX IF NOT EXISTS wa_messages_provider_ref_idx ON wa_messages (provider_ref);
