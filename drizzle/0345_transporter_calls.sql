-- EVERY CALL TO A TRANSPORTER (Nov 2026). Logistics rang transporters and the
-- only trace was a note on each LR's event list and the next-call date moving
-- on — nothing said who was rung, whether they answered, or how often a given
-- transporter is hard to get. One row per call, however many LRs it covered;
-- a no-answer is a row too. Outcome and source are text with checks rather
-- than enums (a new enum value cannot be used in the transaction that adds it).
CREATE TABLE IF NOT EXISTS "erp_transporter_calls" (
  "id" text PRIMARY KEY NOT NULL,
  "transporter" text NOT NULL,
  "transporter_id" text REFERENCES "erp_transporters"("id") ON DELETE SET NULL,
  "outcome" text NOT NULL,
  "source" text DEFAULT 'call' NOT NULL,
  "contact_id" text REFERENCES "erp_transporter_contacts"("id") ON DELETE SET NULL,
  "spoke_to" text,
  "phone" text,
  "note" text,
  "next_call_on" date,
  "transport_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "by_id" text REFERENCES "users"("id"),
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_transporter_calls_outcome" CHECK ("outcome" in ('update','no_change','no_answer','call_back')),
  CONSTRAINT "erp_transporter_calls_source" CHECK ("source" in ('call','whatsapp','tracking')),
  CONSTRAINT "erp_transporter_calls_unanswered_is_a_call" CHECK ("outcome" not in ('no_answer','call_back') or "source" = 'call')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_transporter_calls_transporter_idx" ON "erp_transporter_calls" (lower("transporter"), "at");
