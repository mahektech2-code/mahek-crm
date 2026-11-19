-- Enquiries: a spam stage and a place for a person's corrections.
--
-- SPAM is a stage, not a delete (deleting is separate: see enquiry_deletions below). The website retransmits a submission until it
-- is acknowledged, and `createEnquiryFromWebsite` is idempotent only because
-- the row is still there — delete it and the same junk arrives again as a new
-- enquiry. The literal is ADDED here and USED by no migration, because a value
-- added to an enum may not be used in the transaction that adds it and
-- drizzle-kit runs every pending migration in one.
--
-- CORRECTIONS sit beside `raw_submission` rather than over it: the raw is kept
-- exactly as the visitor sent it, and a corrected name, number or requirement
-- is read on top of it. Each correction's before and after is on the
-- enquiry's activity.
ALTER TYPE "public"."enquiry_stage" ADD VALUE IF NOT EXISTS 'spam';--> statement-breakpoint
ALTER TABLE "enquiries" ADD COLUMN IF NOT EXISTS "corrections" jsonb;--> statement-breakpoint
-- DELETING an enquiry keeps only its website ref, so a retransmission of the
-- same submission is recognised and not stored again (see enquiry_deletions).
CREATE TABLE IF NOT EXISTS "enquiry_deletions" (
  "source" text NOT NULL,
  "external_ref" text NOT NULL,
  "deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "enquiry_deletions_pk" PRIMARY KEY ("source", "external_ref")
);
