-- PRODUCTION PETTY CASH, EXPENSE & FUNDS CONTROL (ERP → Petty cash).
--
-- Three fund accounts — Kotak bank, production bank cash, production customer
-- cash — whose balances are READ OFF an append-only ledger and never typed.
-- An expense and its payments are separate records: the payment status is
-- derived from the payments, a transfer moves money between funds without
-- being an expense, and a customer's cash is a receipt, never revenue.
--
-- The rows written before this keep exactly what they were: the old
-- per-person petty-cash expenses and credits are marked `legacy` and stay on
-- their lists, and nothing about them reaches a fund balance — an opening
-- balance is set through its own verified step, never inferred.

CREATE TABLE IF NOT EXISTS "erp_fund_accounts" (
  "id" text PRIMARY KEY,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "fund_type" text NOT NULL,
  "bank_account_label" text,
  "custodian_employee_id" text REFERENCES "employees"("id"),
  "custodian_user_id" text REFERENCES "users"("id"),
  "godown_id" text REFERENCES "erp_godowns"("id"),
  "opening_balance_paise" bigint,
  "opening_balance_date" date,
  "opening_status" text NOT NULL DEFAULT 'none',
  "opening_note" text,
  "opening_proposed_by_id" text REFERENCES "users"("id"),
  "opening_proposed_at" timestamptz,
  "opening_verified_by_id" text REFERENCES "users"("id"),
  "opening_verified_at" timestamptz,
  "status" text NOT NULL DEFAULT 'active',
  "tally_ledger" text,
  "created_by_id" text REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by_id" text REFERENCES "users"("id"),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "erp_fund_accounts_type_check" CHECK ("fund_type" in ('BANK', 'PHYSICAL_CASH', 'CUSTOMER_CASH')),
  CONSTRAINT "erp_fund_accounts_status_check" CHECK ("status" in ('active', 'inactive')),
  CONSTRAINT "erp_fund_accounts_opening_check" CHECK ("opening_status" in ('none', 'proposed', 'verified')),
  CONSTRAINT "erp_fund_accounts_opening_amount_check" CHECK ("opening_balance_paise" is null or "opening_balance_paise" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_fund_accounts_code_key" ON "erp_fund_accounts" ("code");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_fund_accounts_name_key" ON "erp_fund_accounts" ("name");
--> statement-breakpoint

-- Every posted movement. Nothing updates or deletes a row: a correction is a
-- new row pointing at the one it reverses. `posting_key` is what stops one
-- source being posted twice — `payment:<id>`, `transfer-in:<id>`, ...
CREATE TABLE IF NOT EXISTS "erp_fund_ledger" (
  "id" text PRIMARY KEY,
  "code" text NOT NULL,
  "txn_type" text NOT NULL,
  "fund_account_id" text NOT NULL REFERENCES "erp_fund_accounts"("id"),
  "txn_date" date NOT NULL,
  "amount_paise" bigint NOT NULL,
  "direction" text NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "transfer_id" text,
  "posting_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'posted',
  "narration" text,
  "reversal_of_id" text REFERENCES "erp_fund_ledger"("id"),
  "created_by_id" text REFERENCES "users"("id"),
  "posted_by_id" text REFERENCES "users"("id"),
  "posted_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "erp_fund_ledger_amount_check" CHECK ("amount_paise" > 0),
  CONSTRAINT "erp_fund_ledger_direction_check" CHECK ("direction" in ('credit', 'debit')),
  CONSTRAINT "erp_fund_ledger_status_check" CHECK ("status" = 'posted')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_fund_ledger_posting_key" ON "erp_fund_ledger" ("posting_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_fund_ledger_code_key" ON "erp_fund_ledger" ("code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_fund_ledger_fund_idx" ON "erp_fund_ledger" ("fund_account_id", "txn_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_fund_ledger_source_idx" ON "erp_fund_ledger" ("source_type", "source_id");
--> statement-breakpoint
create or replace function erp_fund_ledger_is_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'erp_fund_ledger is append-only: post a reversal instead';
end;
$$;
--> statement-breakpoint
drop trigger if exists "erp_fund_ledger_no_update" on "erp_fund_ledger";
--> statement-breakpoint
create trigger "erp_fund_ledger_no_update" before update or delete on "erp_fund_ledger" for each row execute function erp_fund_ledger_is_append_only();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_expense_categories" (
  "id" text PRIMARY KEY,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "budget_applicable" boolean NOT NULL DEFAULT true,
  "receipt_required" boolean NOT NULL DEFAULT true,
  "approval_rule" text NOT NULL DEFAULT 'standard',
  "tally_ledger" text,
  "cost_centre" text,
  "sort" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_expense_categories_rule_check" CHECK ("approval_rule" in ('standard', 'approver', 'owner'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_expense_categories_code_key" ON "erp_expense_categories" ("code");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_expense_categories_name_key" ON "erp_expense_categories" (lower("name"));
--> statement-breakpoint
INSERT INTO "erp_expense_categories" ("id", "code", "name", "receipt_required", "sort") VALUES
  ('xcat_purchase_transport', 'PMT', 'Purchase Material Transport', true, 10),
  ('xcat_dispatch_transport', 'DTR', 'Dispatch Transport', true, 20),
  ('xcat_tea_food', 'TFW', 'Tea/Food/Water', false, 30),
  ('xcat_conveyance', 'CNV', 'Staff Conveyance', false, 40),
  ('xcat_fuel', 'FUL', 'Petrol/Diesel', true, 50),
  ('xcat_repairs', 'RPM', 'Repairs and Maintenance', true, 60),
  ('xcat_testing', 'TST', 'Testing Material', true, 70),
  ('xcat_loading', 'LDU', 'Loading/Unloading', false, 80),
  ('xcat_consumables', 'FCN', 'Factory Consumables', true, 90),
  ('xcat_utilities', 'UTL', 'Utilities', true, 100),
  ('xcat_other', 'OTH', 'Other Production Expense', true, 110)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- The expense grows into the production expense. Everything already in it is
-- `legacy`: a record of what was spent before the ledger, read as it was.
ALTER TABLE "erp_expenses" ALTER COLUMN "mode" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_expenses"
  ADD COLUMN IF NOT EXISTS "code" text,
  ADD COLUMN IF NOT EXISTS "legacy" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "category_id" text REFERENCES "erp_expense_categories"("id"),
  ADD COLUMN IF NOT EXISTS "txn_type" text,
  ADD COLUMN IF NOT EXISTS "vendor_name" text,
  ADD COLUMN IF NOT EXISTS "vendor_id" text REFERENCES "erp_suppliers"("id"),
  ADD COLUMN IF NOT EXISTS "bill_no" text,
  ADD COLUMN IF NOT EXISTS "bill_date" date,
  ADD COLUMN IF NOT EXISTS "due_date" date,
  ADD COLUMN IF NOT EXISTS "payment_terms_days" integer,
  ADD COLUMN IF NOT EXISTS "doc_status" text NOT NULL DEFAULT 'attached',
  ADD COLUMN IF NOT EXISTS "department" text,
  ADD COLUMN IF NOT EXISTS "incurred" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "received_at" date,
  ADD COLUMN IF NOT EXISTS "is_advance" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "approval_status" text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS "approval_level" text,
  ADD COLUMN IF NOT EXISTS "approval_rule" text,
  ADD COLUMN IF NOT EXISTS "submitted_by_id" text REFERENCES "users"("id"),
  ADD COLUMN IF NOT EXISTS "submitted_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "decided_by_id" text REFERENCES "users"("id"),
  ADD COLUMN IF NOT EXISTS "decided_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "decision_note" text,
  ADD COLUMN IF NOT EXISTS "doc_exception_by_id" text REFERENCES "users"("id"),
  ADD COLUMN IF NOT EXISTS "doc_exception_reason" text,
  ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
UPDATE "erp_expenses" SET "legacy" = true, "approval_status" = CASE WHEN "status" = 'Verify' THEN 'approved' ELSE 'submitted' END
  WHERE "code" IS NULL AND "legacy" = false;
--> statement-breakpoint
ALTER TABLE "erp_expenses" DROP CONSTRAINT IF EXISTS "erp_expenses_approval_check";
--> statement-breakpoint
ALTER TABLE "erp_expenses" ADD CONSTRAINT "erp_expenses_approval_check"
  CHECK ("approval_status" in ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'returned', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "erp_expenses" DROP CONSTRAINT IF EXISTS "erp_expenses_doc_status_check";
--> statement-breakpoint
ALTER TABLE "erp_expenses" ADD CONSTRAINT "erp_expenses_doc_status_check"
  CHECK ("doc_status" in ('attached', 'to_follow', 'not_available', 'exception_approved'));
--> statement-breakpoint
ALTER TABLE "erp_expenses" DROP CONSTRAINT IF EXISTS "erp_expenses_amount_check";
--> statement-breakpoint
ALTER TABLE "erp_expenses" ADD CONSTRAINT "erp_expenses_amount_check" CHECK ("amount_paise" > 0);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_expenses_code_key" ON "erp_expenses" ("code") WHERE "code" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_credits" ADD COLUMN IF NOT EXISTS "legacy" boolean NOT NULL DEFAULT true;
--> statement-breakpoint

-- What happened to an expense's approval, in order. Append-only.
CREATE TABLE IF NOT EXISTS "erp_expense_approvals" (
  "id" text PRIMARY KEY,
  "expense_id" text NOT NULL REFERENCES "erp_expenses"("id"),
  "action" text NOT NULL,
  "level" text,
  "rule_applied" text,
  "comment" text,
  "by_id" text REFERENCES "users"("id"),
  "at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_expense_approvals_expense_idx" ON "erp_expense_approvals" ("expense_id", "at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_expense_payments" (
  "id" text PRIMARY KEY,
  "code" text NOT NULL,
  "expense_id" text NOT NULL REFERENCES "erp_expenses"("id"),
  "payment_date" date NOT NULL,
  "amount_paise" bigint NOT NULL,
  "fund_account_id" text NOT NULL REFERENCES "erp_fund_accounts"("id"),
  "payee" text,
  "mode" text NOT NULL,
  "reference" text,
  "ack_name" text,
  "ack_file_id" text,
  "evidence_file_id" text,
  "status" text NOT NULL,
  "approval" text NOT NULL DEFAULT 'approved',
  "urgent_reason" text,
  "overdraw_reason" text,
  "split_reference" boolean NOT NULL DEFAULT false,
  "evidence_exception_reason" text,
  "recon_status" text NOT NULL DEFAULT 'not_applicable',
  "request_key" text,
  "requested_by_id" text REFERENCES "users"("id"),
  "recorded_by_id" text REFERENCES "users"("id"),
  "confirmed_by_id" text REFERENCES "users"("id"),
  "confirmed_at" timestamptz,
  "verified_by_id" text REFERENCES "users"("id"),
  "verified_at" timestamptz,
  "reversed_by_id" text REFERENCES "users"("id"),
  "reversed_at" timestamptz,
  "reversal_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "erp_expense_payments_amount_check" CHECK ("amount_paise" > 0),
  CONSTRAINT "erp_expense_payments_status_check" CHECK ("status" in ('requested', 'confirmed', 'reversed', 'cancelled')),
  CONSTRAINT "erp_expense_payments_approval_check" CHECK ("approval" in ('approved', 'urgent')),
  CONSTRAINT "erp_expense_payments_recon_check" CHECK ("recon_status" in ('not_applicable', 'unreconciled', 'matched', 'reconciled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_expense_payments_code_key" ON "erp_expense_payments" ("code");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_expense_payments_request_key" ON "erp_expense_payments" ("request_key") WHERE "request_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_expense_payments_expense_idx" ON "erp_expense_payments" ("expense_id");
--> statement-breakpoint

-- What an expense's payable was adjusted by: a vendor credit, an advance set
-- against the bill, a correction. Approved by somebody else before it counts.
CREATE TABLE IF NOT EXISTS "erp_expense_adjustments" (
  "id" text PRIMARY KEY,
  "expense_id" text NOT NULL REFERENCES "erp_expenses"("id"),
  "kind" text NOT NULL,
  "amount_paise" bigint NOT NULL,
  "advance_expense_id" text REFERENCES "erp_expenses"("id"),
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'requested',
  "requested_by_id" text REFERENCES "users"("id"),
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "decided_by_id" text REFERENCES "users"("id"),
  "decided_at" timestamptz,
  "decision_note" text,
  CONSTRAINT "erp_expense_adjustments_kind_check" CHECK ("kind" in ('correction', 'vendor_credit', 'advance_applied', 'write_off')),
  CONSTRAINT "erp_expense_adjustments_status_check" CHECK ("status" in ('requested', 'approved', 'rejected')),
  CONSTRAINT "erp_expense_adjustments_amount_check" CHECK ("amount_paise" <> 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_expense_adjustments_expense_idx" ON "erp_expense_adjustments" ("expense_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_fund_transfers" (
  "id" text PRIMARY KEY,
  "code" text NOT NULL,
  "transfer_type" text NOT NULL,
  "transfer_date" date NOT NULL,
  "from_fund_id" text NOT NULL REFERENCES "erp_fund_accounts"("id"),
  "to_fund_id" text NOT NULL REFERENCES "erp_fund_accounts"("id"),
  "amount_paise" bigint NOT NULL,
  "purpose" text,
  "bank_reference" text,
  "linked_receipt_ids" text[] NOT NULL DEFAULT '{}',
  "ack_file_id" text,
  "evidence_file_id" text,
  "status" text NOT NULL DEFAULT 'initiated',
  "recon_status" text NOT NULL DEFAULT 'not_applicable',
  "initiated_by_id" text REFERENCES "users"("id"),
  "received_by_id" text REFERENCES "users"("id"),
  "received_at" timestamptz,
  "cancelled_by_id" text REFERENCES "users"("id"),
  "cancel_reason" text,
  "reversal_of_id" text REFERENCES "erp_fund_transfers"("id"),
  "reversed_by_id" text REFERENCES "users"("id"),
  "reversed_at" timestamptz,
  "reversal_reason" text,
  "request_key" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "erp_fund_transfers_amount_check" CHECK ("amount_paise" > 0),
  CONSTRAINT "erp_fund_transfers_funds_check" CHECK ("from_fund_id" <> "to_fund_id"),
  CONSTRAINT "erp_fund_transfers_status_check" CHECK ("status" in ('initiated', 'confirmed', 'cancelled', 'reversed')),
  CONSTRAINT "erp_fund_transfers_recon_check" CHECK ("recon_status" in ('not_applicable', 'unreconciled', 'matched', 'reconciled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_fund_transfers_code_key" ON "erp_fund_transfers" ("code");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_fund_transfers_request_key" ON "erp_fund_transfers" ("request_key") WHERE "request_key" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_customer_cash_receipts" (
  "id" text PRIMARY KEY,
  "receipt_no" text NOT NULL,
  "customer_id" text NOT NULL REFERENCES "customers"("id"),
  "receipt_date" date NOT NULL,
  "amount_paise" bigint NOT NULL,
  "fund_account_id" text NOT NULL REFERENCES "erp_fund_accounts"("id"),
  "allocations" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "ack_file_id" text,
  "evidence_file_id" text,
  "remarks" text,
  "status" text NOT NULL DEFAULT 'posted',
  "verified_by_id" text REFERENCES "users"("id"),
  "verified_at" timestamptz,
  "verify_note" text,
  "crm_reference" text,
  "recorded_by_id" text REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "reversed_by_id" text REFERENCES "users"("id"),
  "reversed_at" timestamptz,
  "reversal_reason" text,
  "request_key" text,
  CONSTRAINT "erp_customer_cash_receipts_amount_check" CHECK ("amount_paise" > 0),
  CONSTRAINT "erp_customer_cash_receipts_status_check" CHECK ("status" in ('posted', 'reversed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_customer_cash_receipts_no_key" ON "erp_customer_cash_receipts" ("receipt_no");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_customer_cash_receipts_request_key" ON "erp_customer_cash_receipts" ("request_key") WHERE "request_key" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_fund_adjustments" (
  "id" text PRIMARY KEY,
  "code" text NOT NULL,
  "fund_account_id" text NOT NULL REFERENCES "erp_fund_accounts"("id"),
  "adj_date" date NOT NULL,
  "amount_paise" bigint NOT NULL,
  "direction" text NOT NULL,
  "kind" text NOT NULL,
  "reason" text NOT NULL,
  "closing_id" text,
  "bank_line_id" text,
  "expense_id" text REFERENCES "erp_expenses"("id"),
  "status" text NOT NULL DEFAULT 'requested',
  "requested_by_id" text REFERENCES "users"("id"),
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "decided_by_id" text REFERENCES "users"("id"),
  "decided_at" timestamptz,
  "decision_note" text,
  CONSTRAINT "erp_fund_adjustments_amount_check" CHECK ("amount_paise" > 0),
  CONSTRAINT "erp_fund_adjustments_direction_check" CHECK ("direction" in ('credit', 'debit')),
  CONSTRAINT "erp_fund_adjustments_kind_check" CHECK ("kind" in ('variance', 'bank_charge', 'correction', 'advance_recovery', 'other')),
  CONSTRAINT "erp_fund_adjustments_status_check" CHECK ("status" in ('requested', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_fund_adjustments_code_key" ON "erp_fund_adjustments" ("code");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_cash_closings" (
  "id" text PRIMARY KEY,
  "fund_account_id" text NOT NULL REFERENCES "erp_fund_accounts"("id"),
  "closing_date" date NOT NULL,
  "opening_paise" bigint NOT NULL,
  "in_paise" bigint NOT NULL,
  "out_paise" bigint NOT NULL,
  "expected_paise" bigint NOT NULL,
  "counted_paise" bigint NOT NULL,
  "variance_paise" bigint NOT NULL,
  "explanation" text,
  "evidence_file_id" text,
  "status" text NOT NULL DEFAULT 'submitted',
  "resolution" text,
  "adjustment_id" text REFERENCES "erp_fund_adjustments"("id"),
  "submitted_by_id" text REFERENCES "users"("id"),
  "submitted_at" timestamptz NOT NULL DEFAULT now(),
  "reviewed_by_id" text REFERENCES "users"("id"),
  "reviewed_at" timestamptz,
  "review_note" text,
  "reopened_reason" text,
  "reopened_at" timestamptz,
  CONSTRAINT "erp_cash_closings_status_check" CHECK ("status" in ('submitted', 'approved', 'returned', 'reopened')),
  CONSTRAINT "erp_cash_closings_counted_check" CHECK ("counted_paise" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_cash_closings_day_key" ON "erp_cash_closings" ("fund_account_id", "closing_date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_expense_budgets" (
  "id" text PRIMARY KEY,
  "period" text NOT NULL,
  "category_id" text NOT NULL REFERENCES "erp_expense_categories"("id"),
  "godown_id" text REFERENCES "erp_godowns"("id"),
  "department" text NOT NULL DEFAULT '',
  "amount_paise" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "created_by_id" text REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "approved_by_id" text REFERENCES "users"("id"),
  "approved_at" timestamptz,
  CONSTRAINT "erp_expense_budgets_period_check" CHECK ("period" ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT "erp_expense_budgets_amount_check" CHECK ("amount_paise" >= 0),
  CONSTRAINT "erp_expense_budgets_status_check" CHECK ("status" in ('draft', 'approved'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_expense_budgets_key" ON "erp_expense_budgets" ("period", "category_id", coalesce("godown_id", ''), "department");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_bank_imports" (
  "id" text PRIMARY KEY,
  "fund_account_id" text NOT NULL REFERENCES "erp_fund_accounts"("id"),
  "file_name" text,
  "file_hash" text NOT NULL,
  "lines_total" integer NOT NULL,
  "lines_new" integer NOT NULL,
  "lines_duplicate" integer NOT NULL,
  "duplicate_of_import_id" text,
  "statement_from" date,
  "statement_to" date,
  "closing_balance_paise" bigint,
  "imported_by_id" text REFERENCES "users"("id"),
  "imported_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_bank_lines" (
  "id" text PRIMARY KEY,
  "import_id" text NOT NULL REFERENCES "erp_bank_imports"("id"),
  "fund_account_id" text NOT NULL REFERENCES "erp_fund_accounts"("id"),
  "line_hash" text NOT NULL,
  "statement_txn_id" text,
  "txn_date" date NOT NULL,
  "value_date" date,
  "narration" text,
  "reference" text,
  "debit_paise" bigint NOT NULL DEFAULT 0,
  "credit_paise" bigint NOT NULL DEFAULT 0,
  "balance_paise" bigint,
  "recon_status" text NOT NULL DEFAULT 'unmatched',
  "exception_reason" text,
  "reconciled_by_id" text REFERENCES "users"("id"),
  "reconciled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "erp_bank_lines_amount_check" CHECK ("debit_paise" >= 0 and "credit_paise" >= 0 and ("debit_paise" > 0) <> ("credit_paise" > 0)),
  CONSTRAINT "erp_bank_lines_status_check" CHECK ("recon_status" in ('unmatched', 'suggested', 'matched', 'reconciled', 'exception', 'correction'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_bank_lines_hash_key" ON "erp_bank_lines" ("fund_account_id", "line_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_bank_lines_date_idx" ON "erp_bank_lines" ("fund_account_id", "txn_date");
--> statement-breakpoint
-- What a statement line was matched to. A record is matched once; a line may
-- carry several records only where their total stays within it (a split).
CREATE TABLE IF NOT EXISTS "erp_bank_matches" (
  "id" text PRIMARY KEY,
  "bank_line_id" text NOT NULL REFERENCES "erp_bank_lines"("id"),
  "record_type" text NOT NULL,
  "record_id" text NOT NULL,
  "amount_paise" bigint NOT NULL,
  "rule" text NOT NULL,
  "confirmed" boolean NOT NULL DEFAULT false,
  "matched_by_id" text REFERENCES "users"("id"),
  "matched_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "erp_bank_matches_type_check" CHECK ("record_type" in ('payment', 'transfer', 'adjustment')),
  CONSTRAINT "erp_bank_matches_rule_check" CHECK ("rule" in ('reference', 'amount_date', 'narration', 'manual')),
  CONSTRAINT "erp_bank_matches_amount_check" CHECK ("amount_paise" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_bank_matches_record_key" ON "erp_bank_matches" ("record_type", "record_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_bank_matches_line_idx" ON "erp_bank_matches" ("bank_line_id");
--> statement-breakpoint

-- TallyPrime: one row per record that should reach the books, with its own
-- status — a completed payment is not a posted voucher.
CREATE TABLE IF NOT EXISTS "erp_tally_sync" (
  "id" text PRIMARY KEY,
  "record_type" text NOT NULL,
  "record_id" text NOT NULL,
  "remote_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "voucher_type" text,
  "voucher_no" text,
  "tally_company" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "last_attempt_at" timestamptz,
  "posted_at" timestamptz,
  "updated_by_id" text REFERENCES "users"("id"),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "erp_tally_sync_type_check" CHECK ("record_type" in ('expense', 'payment', 'transfer', 'receipt', 'adjustment')),
  CONSTRAINT "erp_tally_sync_status_check" CHECK ("status" in ('not_required', 'pending', 'syncing', 'posted', 'failed', 'correction', 'reversed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_tally_sync_record_key" ON "erp_tally_sync" ("record_type", "record_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_tally_sync_remote_key" ON "erp_tally_sync" ("remote_id");
--> statement-breakpoint

-- Evidence on a petty-cash record: what kind of document each file is. The
-- file itself is an attachment parented `erp_petty` to the record. Files are
-- added, never replaced.
CREATE TABLE IF NOT EXISTS "erp_petty_evidence" (
  "id" text PRIMARY KEY,
  "record_type" text NOT NULL,
  "record_id" text NOT NULL,
  "attachment_id" text NOT NULL,
  "kind" text NOT NULL,
  "note" text,
  "uploaded_by_id" text REFERENCES "users"("id"),
  "uploaded_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_petty_evidence_record_idx" ON "erp_petty_evidence" ("record_type", "record_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_petty_evidence_file_key" ON "erp_petty_evidence" ("attachment_id");
--> statement-breakpoint

INSERT INTO "erp_series" ("key", "last") VALUES
  ('expense', 0), ('payment', 0), ('transfer', 0), ('receipt', 0), ('fundTxn', 0), ('adjustment', 0)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE IF NOT EXISTS 'erp_petty';
--> statement-breakpoint
-- The three accounts the factory works with. No opening balance: that is set
-- on the Settings tab, proposed by one person and verified by another.
INSERT INTO "erp_fund_accounts" ("id", "code", "name", "fund_type", "bank_account_label", "godown_id") VALUES
  ('fund_kotak', 'KOTAK', 'Kotak Bank — Company Account', 'BANK', 'Kotak Mahindra Bank', NULL),
  ('fund_prod_bank_cash', 'PBC', 'Production Bank Cash', 'PHYSICAL_CASH', NULL, (select id from erp_godowns where lower(name) like 'ambernath%' order by name limit 1)),
  ('fund_prod_customer_cash', 'PCC', 'Production Customer Cash', 'CUSTOMER_CASH', NULL, (select id from erp_godowns where lower(name) like 'ambernath%' order by name limit 1))
ON CONFLICT DO NOTHING;
