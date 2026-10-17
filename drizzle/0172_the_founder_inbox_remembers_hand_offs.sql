-- The Founder Command Centre's "Needs you" inbox.
--
-- An inbox item is DERIVED from a live rule and is never stored: it appears
-- when its condition holds and leaves when it clears. What IS stored is the
-- human half — who an item was handed on to, and who snoozed it until when —
-- because that is a decision somebody made and a rebuild must not forget it.
--
-- One row per viewer per item: a snooze is personal (it stops only this
-- person seeing it); a hand-off names the colleague it went to.
CREATE TABLE IF NOT EXISTS "founder_inbox_marks" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "item_key" text NOT NULL,
  "kind" text NOT NULL,
  "to_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "note" text,
  "until_date" date,
  "why" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "founder_inbox_marks_kind_check" CHECK ("kind" IN ('handed', 'snoozed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "founder_inbox_marks_user_item_key" ON "founder_inbox_marks" ("user_id", "item_key");
