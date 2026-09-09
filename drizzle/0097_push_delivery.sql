-- Whether a push actually arrived, which nothing has ever been able to say.
--
-- Expo's push API is TWO phases and only the first was ever used: `send`
-- returns a ticket per message, and a ticket means "accepted for delivery",
-- not "delivered". The verdict comes later from `getReceipts`, and it is the
-- only place `DeviceNotRegistered` — a token that will never work again —
-- is ever reported. Without reading it, a token stays on the row for ever,
-- every send to it is thrown away by Expo, and the office sees success.
--
-- This is a WORKLIST rather than a log. A row is written when a message is
-- accepted, deleted when its receipt says it arrived, and KEPT with the
-- reason when it did not. So the size of this table is "pushes not yet
-- confirmed, plus recent failures", which is small on purpose and is
-- exactly the list somebody wants when they ask why a push did not come.
CREATE TABLE IF NOT EXISTS "mbos_push_receipts" (
  "id" text PRIMARY KEY NOT NULL,
  -- Expo's ticket. Null where the send itself was refused, which is a
  -- failure that never gets a receipt and must not wait for one.
  "ticket_id" text,
  "device_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- The notification row this rode on. The row is the record; the push is a
  -- courtesy on top of it, so this is nullable rather than load-bearing.
  "notification_id" text,
  -- The token as it was AT SEND TIME. Kept because invalidation has to know
  -- which string to clear, and the device row may have rotated since.
  "push_token" text NOT NULL,
  -- accepted · delivered · failed
  "status" text NOT NULL DEFAULT 'accepted',
  "error_code" text,
  "error_detail" text,
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL,
  "checked_at" timestamp with time zone
);

-- The receipt poller's own query: everything accepted and not yet checked,
-- oldest first. Expo keeps receipts for 24 hours, so this is a short list.
CREATE INDEX IF NOT EXISTS "mbos_push_receipts_pending_idx"
  ON "mbos_push_receipts" ("status", "sent_at")
  WHERE "checked_at" IS NULL;

CREATE INDEX IF NOT EXISTS "mbos_push_receipts_user_idx"
  ON "mbos_push_receipts" ("user_id", "sent_at" DESC);
