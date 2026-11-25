-- Studio Timeline: one permanent, append-only row per recipient per act (individual or bulk, Kapso or manual).
-- Names are snapshots so history survives a changed or removed poster, lead or employee. Provider-confirmed status
-- (sent / delivered / read / failed) is NOT stored here: it is read from studio_wa_messages through wa_message_id.
-- One new table; nothing existing is touched; no backfill.

CREATE TABLE IF NOT EXISTS "studio_activities" (
  "id" text PRIMARY KEY NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
  "kind" text NOT NULL,
  "content_name" text NOT NULL,
  "content_ref_type" text,
  "content_ref_id" text,
  "caption" text,
  "sender_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "sender_name" text NOT NULL,
  "customer_id" text REFERENCES "customers"("id") ON DELETE SET NULL,
  "recipient_name" text NOT NULL,
  "mode" text NOT NULL,
  "channel" text NOT NULL,
  "action" text NOT NULL,
  "reason" text,
  "wa_message_id" text,
  "batch_ref" text,
  CONSTRAINT "studio_activities_kind" CHECK ("kind" in ('poster','brochure','price_list','video','image','product_info','message')),
  CONSTRAINT "studio_activities_mode" CHECK ("mode" in ('individual','bulk','inbox','forward_manual')),
  CONSTRAINT "studio_activities_channel" CHECK ("channel" in ('kapso','whatsapp_chat','download','device')),
  CONSTRAINT "studio_activities_action" CHECK ("action" in ('kapso_handed','not_sent','chat_opened','marked_sent','marked_skipped','marked_undone','downloaded','shared_device'))
);
CREATE INDEX IF NOT EXISTS "studio_activities_customer_idx" ON "studio_activities" ("customer_id","occurred_at");
CREATE INDEX IF NOT EXISTS "studio_activities_sender_idx" ON "studio_activities" ("sender_id","occurred_at");
CREATE INDEX IF NOT EXISTS "studio_activities_at_idx" ON "studio_activities" ("occurred_at");
CREATE INDEX IF NOT EXISTS "studio_activities_wa_idx" ON "studio_activities" ("wa_message_id");
