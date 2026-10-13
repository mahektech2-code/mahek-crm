-- An SFG lot's QC decision carries the same evidence a purchase test does:
-- a photograph per test, the smell, the pH and density readings and a video,
-- none of it required. `tests` keeps the Pass / Fail answers the factory phone
-- still records; this column is what the ERP's approve and reject prompts send.
ALTER TABLE "erp_sfg_qc" ADD COLUMN IF NOT EXISTS "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE IF NOT EXISTS 'erp_sfg_qc';
