-- WhatsApp DND: a customer who must receive no WhatsApp message, by any path.
-- Separate from do_not_contact, which also stops calls. The four columns are
-- the current answer; whatsapp_dnd_events is the history with its remarks.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "whatsapp_dnd" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "whatsapp_dnd_reason" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "whatsapp_dnd_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "whatsapp_dnd_by_name" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_dnd_events" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"dnd" boolean NOT NULL,
	"reason" text NOT NULL,
	"changed_by_id" text,
	"changed_by_name" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "whatsapp_dnd_events" ADD CONSTRAINT "whatsapp_dnd_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "whatsapp_dnd_events" ADD CONSTRAINT "whatsapp_dnd_events_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_dnd_events_customer_idx" ON "whatsapp_dnd_events" USING btree ("customer_id","at" DESC NULLS LAST);
