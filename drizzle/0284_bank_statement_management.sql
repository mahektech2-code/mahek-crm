-- Bank statement management (Accounts). The bank's own PDF is uploaded as
-- often as anybody likes, read by OpenAI into lines, checked, and imported
-- into erp_bank_lines -- the one store of bank lines, which Petty Cash reads
-- too. A line is then matched to a customer receipt, a vendor payout or a
-- Petty Cash transaction, marked by hand, or set aside. The PDF is kept for
-- bankStatements.pdfRetentionDays (7) and deleted; the lines stay.
ALTER TABLE "erp_money_accounts" ADD COLUMN IF NOT EXISTS "bank_name" text;
--> statement-breakpoint
ALTER TABLE "erp_money_accounts" ADD COLUMN IF NOT EXISTS "account_type" text;
--> statement-breakpoint
UPDATE "erp_money_accounts" SET "bank_name" = 'Kotak Mahindra', "account_type" = coalesce("account_type", 'Current') WHERE "id" = 'macc_kotak' AND "bank_name" IS NULL;
--> statement-breakpoint
UPDATE "erp_money_accounts" SET "bank_name" = 'ICICI Bank', "account_type" = coalesce("account_type", 'Current') WHERE "id" = 'macc_icici' AND "bank_name" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bank_statement_uploads" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL REFERENCES "erp_money_accounts"("id"),
  "file_name" text NOT NULL,
  "file_size" integer NOT NULL,
  "file_ref" text,
  "pages" integer,
  "note" text,
  "status" text DEFAULT 'reading' NOT NULL,
  "step" text,
  "error" text,
  "period_from" text,
  "period_to" text,
  "opening_paise" bigint,
  "closing_paise" bigint,
  "rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "balance_ok" boolean,
  "break_at" integer,
  "lines_read" integer DEFAULT 0 NOT NULL,
  "lines_new" integer DEFAULT 0 NOT NULL,
  "lines_existing" integer DEFAULT 0 NOT NULL,
  "model" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "uploaded_by_id" text REFERENCES "users"("id"),
  "uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "read_at" timestamp with time zone,
  "imported_at" timestamp with time zone,
  "imported_by_id" text REFERENCES "users"("id"),
  "pdf_expires_at" timestamp with time zone NOT NULL,
  "pdf_deleted_at" timestamp with time zone,
  CONSTRAINT "bank_statement_uploads_status_check" CHECK ("status" in ('reading', 'ready', 'failed', 'imported', 'discarded'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_statement_uploads_account_idx" ON "bank_statement_uploads" ("account_id", "uploaded_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_statement_uploads_pdf_idx" ON "bank_statement_uploads" ("pdf_expires_at") WHERE "pdf_deleted_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "erp_bank_lines" ADD COLUMN IF NOT EXISTS "upload_id" text REFERENCES "bank_statement_uploads"("id");
--> statement-breakpoint
ALTER TABLE "erp_bank_lines" ADD COLUMN IF NOT EXISTS "line_no" integer;
--> statement-breakpoint
ALTER TABLE "erp_bank_lines" ADD COLUMN IF NOT EXISTS "page" integer;
--> statement-breakpoint
ALTER TABLE "erp_bank_lines" ADD COLUMN IF NOT EXISTS "confidence" integer;
--> statement-breakpoint
ALTER TABLE "erp_bank_lines" ADD COLUMN IF NOT EXISTS "flag" text;
--> statement-breakpoint
ALTER TABLE "erp_bank_lines" ADD COLUMN IF NOT EXISTS "flag_note" text;
--> statement-breakpoint
ALTER TABLE "erp_bank_lines" ADD COLUMN IF NOT EXISTS "suggestion" jsonb;
--> statement-breakpoint
ALTER TABLE "erp_bank_lines" ADD COLUMN IF NOT EXISTS "marked_as" text;
--> statement-breakpoint
ALTER TABLE "erp_bank_lines" ADD COLUMN IF NOT EXISTS "edited_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_bank_lines" ADD COLUMN IF NOT EXISTS "edited_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_bank_lines_upload_idx" ON "erp_bank_lines" ("upload_id");
--> statement-breakpoint
ALTER TABLE "erp_bank_matches" ALTER COLUMN "txn_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_bank_matches" ADD COLUMN IF NOT EXISTS "receipt_id" text REFERENCES "payment_receipts"("id");
--> statement-breakpoint
ALTER TABLE "erp_bank_matches" ADD COLUMN IF NOT EXISTS "payout_id" text REFERENCES "vendor_payouts"("id");
--> statement-breakpoint
ALTER TABLE "erp_bank_matches" DROP CONSTRAINT IF EXISTS "erp_bank_matches_one_target_check";
--> statement-breakpoint
ALTER TABLE "erp_bank_matches" ADD CONSTRAINT "erp_bank_matches_one_target_check" CHECK (num_nonnulls("txn_id", "receipt_id", "payout_id") = 1);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_bank_matches_receipt_idx" ON "erp_bank_matches" ("receipt_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_bank_matches_payout_idx" ON "erp_bank_matches" ("payout_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_bank_matches_receipt_live_key" ON "erp_bank_matches" ("receipt_id") WHERE "voided_at" IS NULL AND "receipt_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_bank_matches_payout_live_key" ON "erp_bank_matches" ("payout_id") WHERE "voided_at" IS NULL AND "payout_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_bank_lines" ADD COLUMN IF NOT EXISTS "dismissed" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_bank_matches" ADD COLUMN IF NOT EXISTS "via" text;
--> statement-breakpoint
ALTER TABLE "erp_bank_lines" ADD COLUMN IF NOT EXISTS "balance_break" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_bank_lines" ADD COLUMN IF NOT EXISTS "flag_receipt_id" text REFERENCES "payment_receipts"("id");
