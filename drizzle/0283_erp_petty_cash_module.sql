-- The Petty Cash module (spec v1.0, 20 Oct 2026). It replaces the old
-- "Petty Cash/Bank" screens (funds given and expenses per employee): those
-- tables stay where they are, read by the "Old records" tab and written by
-- nothing. One real movement of money is one row of erp_money_txns.
CREATE TABLE IF NOT EXISTS "erp_money_accounts" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "last4" text,
  "opening_paise" bigint DEFAULT 0 NOT NULL,
  "opening_date" date,
  "active" boolean DEFAULT true NOT NULL,
  "sort" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_money_accounts_kind_check" CHECK ("kind" in ('bank', 'cash', 'petty'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_money_accounts_name_key" ON "erp_money_accounts" ("name");
--> statement-breakpoint
INSERT INTO "erp_money_accounts" ("id", "name", "kind", "sort") VALUES
  ('macc_kotak', 'Kotak Bank', 'bank', 1),
  ('macc_icici', 'ICICI Bank', 'bank', 2),
  ('macc_cash', 'Cash in Hand', 'cash', 3),
  ('macc_petty', 'Petty Cash', 'petty', 4)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_advances" (
  "id" text PRIMARY KEY NOT NULL,
  "advance_no" integer NOT NULL,
  "employee_name" text NOT NULL,
  "purpose" text,
  "issued_on" date NOT NULL,
  "bills_due_on" date,
  "status" text DEFAULT 'open' NOT NULL,
  "settled_at" timestamp with time zone,
  "settled_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_advances_status_check" CHECK ("status" in ('open', 'settled', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_advances_no_key" ON "erp_advances" ("advance_no");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_money_txns" (
  "id" text PRIMARY KEY NOT NULL,
  "txn_no" integer NOT NULL,
  "txn_date" date NOT NULL,
  "kind" text NOT NULL,
  "amount_paise" bigint NOT NULL,
  "from_account_id" text REFERENCES "erp_money_accounts"("id"),
  "to_account_id" text REFERENCES "erp_money_accounts"("id"),
  "mode" text,
  "reference" text,
  "category" text,
  "payee" text,
  "invoice_no" text,
  "description" text,
  "petty" boolean DEFAULT false NOT NULL,
  "customer_id" text REFERENCES "customers"("id"),
  "payer" text,
  "bills_text" text,
  "scrap_receipt_id" text REFERENCES "erp_cash_receipts"("id"),
  "source_txn_id" text REFERENCES "erp_money_txns"("id"),
  "advance_id" text REFERENCES "erp_advances"("id"),
  "no_bill_reason" text,
  "review" text DEFAULT 'none' NOT NULL,
  "review_note" text,
  "reviewed_by_id" text REFERENCES "users"("id"),
  "reviewed_at" timestamp with time zone,
  "duplicate_override" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "cancel_reason" text,
  "cancelled_by_id" text REFERENCES "users"("id"),
  "cancelled_at" timestamp with time zone,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_money_txns_amount_check" CHECK ("amount_paise" > 0),
  CONSTRAINT "erp_money_txns_kind_check" CHECK ("kind" in ('expense', 'receipt', 'transfer', 'advance', 'advance_return', 'advance_topup')),
  CONSTRAINT "erp_money_txns_status_check" CHECK ("status" in ('active', 'cancelled')),
  CONSTRAINT "erp_money_txns_review_check" CHECK ("review" in ('none', 'to_review', 'approved', 'sent_back')),
  CONSTRAINT "erp_money_txns_cancel_check" CHECK (("status" = 'cancelled') = ("cancel_reason" is not null)),
  CONSTRAINT "erp_money_txns_transfer_check" CHECK ("kind" <> 'transfer' or ("from_account_id" is not null and "to_account_id" is not null and "from_account_id" <> "to_account_id")),
  CONSTRAINT "erp_money_txns_receipt_check" CHECK ("kind" <> 'receipt' or ("to_account_id" is not null and "from_account_id" is null)),
  CONSTRAINT "erp_money_txns_expense_check" CHECK ("kind" <> 'expense' or ("to_account_id" is null and (("from_account_id" is null) = ("advance_id" is not null))))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_money_txns_no_key" ON "erp_money_txns" ("txn_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_money_txns_date_idx" ON "erp_money_txns" ("txn_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_money_txns_kind_idx" ON "erp_money_txns" ("kind", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_money_txns_invoice_idx" ON "erp_money_txns" ("invoice_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_money_txns_advance_idx" ON "erp_money_txns" ("advance_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_money_txns_source_idx" ON "erp_money_txns" ("source_txn_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_money_txns_scrap_key" ON "erp_money_txns" ("scrap_receipt_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_bank_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL REFERENCES "erp_money_accounts"("id"),
  "line_date" date NOT NULL,
  "description" text NOT NULL,
  "reference" text,
  "debit_paise" bigint DEFAULT 0 NOT NULL,
  "credit_paise" bigint DEFAULT 0 NOT NULL,
  "balance_paise" bigint,
  "line_key" text NOT NULL,
  "import_batch" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "ignore_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_bank_lines_side_check" CHECK (("debit_paise" > 0) <> ("credit_paise" > 0)),
  CONSTRAINT "erp_bank_lines_status_check" CHECK ("status" in ('open', 'ignored'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_bank_lines_key" ON "erp_bank_lines" ("account_id", "line_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_bank_lines_date_idx" ON "erp_bank_lines" ("account_id", "line_date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_bank_matches" (
  "id" text PRIMARY KEY NOT NULL,
  "line_id" text NOT NULL REFERENCES "erp_bank_lines"("id"),
  "txn_id" text NOT NULL REFERENCES "erp_money_txns"("id"),
  "amount_paise" bigint NOT NULL,
  "by_id" text REFERENCES "users"("id"),
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "voided_at" timestamp with time zone,
  "voided_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_bank_matches_amount_check" CHECK ("amount_paise" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_bank_matches_line_idx" ON "erp_bank_matches" ("line_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_bank_matches_txn_idx" ON "erp_bank_matches" ("txn_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_bank_matches_live_key" ON "erp_bank_matches" ("line_id", "txn_id") WHERE "voided_at" is null;
--> statement-breakpoint
INSERT INTO "erp_series" ("key", "last") VALUES ('moneyTxn', 0), ('advance', 0) ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Every scrap receipt already recorded is money that arrived: it becomes a
-- receipt row here too, into Kotak where it came by bank and Cash in Hand
-- where it came in cash, so the balances include it from day one.
INSERT INTO "erp_money_txns" ("id", "txn_no", "txn_date", "kind", "amount_paise", "to_account_id", "mode", "reference", "payer", "scrap_receipt_id", "status", "cancel_reason", "note", "created_at", "created_by_id")
SELECT 'mtx_' || substr(md5(r.id), 1, 16),
       (SELECT last FROM "erp_series" WHERE "key" = 'moneyTxn') + row_number() OVER (ORDER BY r.receipt_date, r.receipt_no),
       r.receipt_date, 'receipt', r.amount_paise,
       CASE WHEN r.mode = 'Cash' THEN 'macc_cash' ELSE 'macc_kotak' END,
       CASE r.mode WHEN 'Bank transfer' THEN 'NEFT' ELSE r.mode END,
       r.reference, coalesce(b.name, r.payer), r.id,
       CASE WHEN r.status = 'void' THEN 'cancelled' ELSE 'active' END,
       CASE WHEN r.status = 'void' THEN coalesce(r.void_reason, 'Void') END,
       r.note, r.created_at, r.created_by_id
  FROM "erp_cash_receipts" r
  LEFT JOIN "erp_scrap_buyers" b ON b.id = r.buyer_id
 WHERE NOT EXISTS (SELECT 1 FROM "erp_money_txns" t WHERE t.scrap_receipt_id = r.id);
--> statement-breakpoint
UPDATE "erp_series" SET "last" = greatest("last", (SELECT coalesce(max(txn_no), 0) FROM "erp_money_txns")) WHERE "key" = 'moneyTxn';
--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE IF NOT EXISTS 'erp_money_txn';
