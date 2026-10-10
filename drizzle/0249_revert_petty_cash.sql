-- Petty cash funds control (0248) is withdrawn. Its tables go, the columns it
-- added to erp_expenses and erp_credits go, and the screen is the earlier
-- Expenses / Funds given pair again. Rows those two screens already held were
-- marked legacy by 0248 and are kept; rows only the new module wrote are not.
-- The attachment_parent value 'erp_petty' stays: Postgres cannot drop one.
DROP TABLE IF EXISTS "erp_petty_evidence";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_tally_sync";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_bank_matches";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_bank_lines";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_bank_imports";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_expense_budgets";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_cash_closings";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_fund_adjustments";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_customer_cash_receipts";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_fund_transfers";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_expense_adjustments";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_expense_payments";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_expense_approvals";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_fund_ledger";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "erp_fund_ledger_is_append_only"() CASCADE;
--> statement-breakpoint
DELETE FROM "erp_expenses" WHERE "legacy" = false;
--> statement-breakpoint
DELETE FROM "erp_credits" WHERE "legacy" = false;
--> statement-breakpoint
ALTER TABLE "erp_expenses" DROP CONSTRAINT IF EXISTS "erp_expenses_approval_check";
--> statement-breakpoint
ALTER TABLE "erp_expenses" DROP CONSTRAINT IF EXISTS "erp_expenses_doc_status_check";
--> statement-breakpoint
DROP INDEX IF EXISTS "erp_expenses_code_key";
--> statement-breakpoint
ALTER TABLE "erp_expenses"
  DROP COLUMN IF EXISTS "code",
  DROP COLUMN IF EXISTS "legacy",
  DROP COLUMN IF EXISTS "category_id",
  DROP COLUMN IF EXISTS "txn_type",
  DROP COLUMN IF EXISTS "vendor_name",
  DROP COLUMN IF EXISTS "vendor_id",
  DROP COLUMN IF EXISTS "bill_no",
  DROP COLUMN IF EXISTS "bill_date",
  DROP COLUMN IF EXISTS "due_date",
  DROP COLUMN IF EXISTS "payment_terms_days",
  DROP COLUMN IF EXISTS "doc_status",
  DROP COLUMN IF EXISTS "department",
  DROP COLUMN IF EXISTS "incurred",
  DROP COLUMN IF EXISTS "received_at",
  DROP COLUMN IF EXISTS "is_advance",
  DROP COLUMN IF EXISTS "approval_status",
  DROP COLUMN IF EXISTS "approval_level",
  DROP COLUMN IF EXISTS "approval_rule",
  DROP COLUMN IF EXISTS "submitted_by_id",
  DROP COLUMN IF EXISTS "submitted_at",
  DROP COLUMN IF EXISTS "decided_by_id",
  DROP COLUMN IF EXISTS "decided_at",
  DROP COLUMN IF EXISTS "decision_note",
  DROP COLUMN IF EXISTS "doc_exception_by_id",
  DROP COLUMN IF EXISTS "doc_exception_reason",
  DROP COLUMN IF EXISTS "version";
--> statement-breakpoint
UPDATE "erp_expenses" SET "mode" = 'Cash' WHERE "mode" IS NULL;
--> statement-breakpoint
ALTER TABLE "erp_expenses" ALTER COLUMN "mode" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_credits" DROP COLUMN IF EXISTS "legacy";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_expense_categories";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_fund_accounts";
--> statement-breakpoint
DELETE FROM "erp_series" WHERE "key" IN ('expense', 'payment', 'transfer', 'receipt', 'fundTxn', 'adjustment');
--> statement-breakpoint
DELETE FROM "erp_user_powers" WHERE "power" IN ('pettyAccounts', 'pettyApprove', 'pettyOwner');
--> statement-breakpoint
DELETE FROM "app_settings" WHERE "key" LIKE 'erp.pettyCash.%' OR "key" LIKE 'erp.tally.%';
