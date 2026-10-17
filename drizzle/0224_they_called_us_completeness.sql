-- "THEY CALLED US", COMPLETED (0224) — ADDITIVE ONLY.
--
-- Every column below is nullable or carries a default that equals what every
-- existing row already is, so no historical row changes meaning and nothing is
-- backfilled. Nothing is dropped, renamed or rewritten.

-- Was an opportunity asked about, and was the answer yes or no. Null is
-- "nobody asked" — every call that exists today.
ALTER TABLE "calls" ADD COLUMN "opportunity_answer" text;--> statement-breakpoint

-- The figures behind the conversation, as the server read them at save.
ALTER TABLE "calls" ADD COLUMN "context_snapshot" jsonb;--> statement-breakpoint

-- An opportunity becomes something that can be worked. Every existing row is
-- `open`, which is what it is.
ALTER TABLE "call_opportunities" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "call_opportunities" ADD COLUMN "assigned_user_id" text;--> statement-breakpoint
ALTER TABLE "call_opportunities" ADD COLUMN "worked_note" text;--> statement-breakpoint
ALTER TABLE "call_opportunities" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "call_opportunities" ADD COLUMN "closed_by_id" text;--> statement-breakpoint

ALTER TABLE "call_opportunities"
  ADD CONSTRAINT "call_opportunities_assigned_user_id_users_id_fk"
  FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "call_opportunities_assignee_idx"
  ON "call_opportunities" ("assigned_user_id", "status");
