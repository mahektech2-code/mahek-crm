-- Studio: WhatsApp Inbox.
--
-- What Kapso says about the company WhatsApp number, kept so the Inbox opens
-- without a round trip: conversations, messages (one row per WhatsApp message
-- id) and the webhook deliveries already handled (so a retry does nothing
-- twice). Three new tables; nothing existing is touched. Nothing is sent by
-- this migration or stored from anywhere but Kapso.

CREATE TABLE IF NOT EXISTS "studio_wa_conversations" (
  "id" text PRIMARY KEY NOT NULL,
  "phone_number_id" text NOT NULL,
  "phone" text,
  "phone_key" text,
  "contact_name" text,
  "last_message_text" text,
  "last_message_at" timestamp with time zone,
  "last_inbound_at" timestamp with time zone,
  "unread" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "studio_wa_conversations_recent_idx" ON "studio_wa_conversations" ("phone_number_id","last_message_at" DESC);
CREATE INDEX IF NOT EXISTS "studio_wa_conversations_phone_key_idx" ON "studio_wa_conversations" ("phone_key");

CREATE TABLE IF NOT EXISTS "studio_wa_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "conversation_id" text NOT NULL REFERENCES "studio_wa_conversations"("id") ON DELETE CASCADE,
  "wamid" text NOT NULL,
  "direction" text NOT NULL,
  "type" text NOT NULL DEFAULT 'text',
  "body" text,
  "caption" text,
  "has_media" boolean NOT NULL DEFAULT false,
  "media_type" text,
  "media_url" text,
  "status" text,
  "error_code" text,
  "error_text" text,
  "origin" text,
  "sent_by_id" text REFERENCES "users"("id"),
  "poster_id" text REFERENCES "studio_posters"("id") ON DELETE SET NULL,
  "client_key" text,
  "at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "studio_wa_messages_direction" CHECK ("direction" in ('inbound','outbound')),
  CONSTRAINT "studio_wa_messages_status" CHECK ("status" is null or "status" in ('pending','sent','delivered','read','failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "studio_wa_messages_wamid_key" ON "studio_wa_messages" ("wamid");
CREATE UNIQUE INDEX IF NOT EXISTS "studio_wa_messages_client_key" ON "studio_wa_messages" ("client_key");
CREATE INDEX IF NOT EXISTS "studio_wa_messages_thread_idx" ON "studio_wa_messages" ("conversation_id","at");

CREATE TABLE IF NOT EXISTS "studio_wa_events" (
  "key" text PRIMARY KEY NOT NULL,
  "event" text NOT NULL,
  "received_at" timestamp with time zone NOT NULL DEFAULT now()
);
