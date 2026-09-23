-- WhatsApp through Wati, behind a switch only the founder holds.
--
-- whatsapp_service_events: the switch, one row per decision. No row = OFF.
-- wa_templates.wati_template_name: which approved Wati template a CRM template
--   is sent as; null means it can only go the manual way.
-- wa_messages.provider_ref: WhatsApp's own message id, for tracing.
-- wa_replies: a reply from an unknown number is kept rather than dropped, and
--   WhatsApp's message id makes a retried webhook land once.
CREATE TABLE IF NOT EXISTS "whatsapp_service_events" (
	"id" text PRIMARY KEY NOT NULL,
	"active" boolean NOT NULL,
	"note" text,
	"changed_by_id" text,
	"changed_by_name" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "whatsapp_service_events" ADD CONSTRAINT "whatsapp_service_events_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_service_events_at_idx" ON "whatsapp_service_events" USING btree ("at" DESC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "wa_templates" ADD COLUMN IF NOT EXISTS "wati_template_name" text;
--> statement-breakpoint
ALTER TABLE "wa_messages" ADD COLUMN IF NOT EXISTS "provider_ref" text;
--> statement-breakpoint
ALTER TABLE "wa_replies" ALTER COLUMN "customer_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "wa_replies" ADD COLUMN IF NOT EXISTS "wa_id" text;
--> statement-breakpoint
ALTER TABLE "wa_replies" ADD COLUMN IF NOT EXISTS "sender_name" text;
--> statement-breakpoint
ALTER TABLE "wa_replies" ADD COLUMN IF NOT EXISTS "provider_message_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wa_replies_provider_message_id_key" ON "wa_replies" USING btree ("provider_message_id");
