-- Enquiries: a spam stage and a place for a person's corrections.
--
-- SPAM is a stage, not a delete. The website retransmits a submission until it
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
ALTER TABLE "enquiries" ADD COLUMN IF NOT EXISTS "corrections" jsonb;
