-- THE VISIT ASSISTANT keeps what it heard in the same table as the call
-- assistant, because it is the same record: the transcript, the proposal,
-- and what the visit was finally saved as. `channel` says which assistant
-- wrote the row — every existing row is a call — and `visit_id` is filled by
-- the sync handler when the visit it proposed lands.
ALTER TABLE "call_ai_drafts" ADD COLUMN IF NOT EXISTS "channel" text DEFAULT 'call' NOT NULL;
--> statement-breakpoint
ALTER TABLE "call_ai_drafts" ADD COLUMN IF NOT EXISTS "visit_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_ai_drafts_visit_idx" ON "call_ai_drafts" USING btree ("visit_id");
