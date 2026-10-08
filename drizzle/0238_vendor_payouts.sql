-- VENDOR PAYOUTS (0238) — ADDITIVE ONLY.
--
-- What Mahek owes its suppliers, and the day accounts will pay it. Payments go
-- out on the payment days (Tuesday to Friday by default, IST — the
-- `payments.vendorPayoutDays` setting), so every payout carries two dates:
--
--   * due_date — the purchase date plus the supplier's credit days: when the
--     money is OWED.
--   * pay_on   — the payment day it is planned for: the first payment day on
--     or after the due date, until a person drags it somewhere else. Once a
--     person has moved it, pay_on_decided_at is set and the register sync
--     never moves it back.
--
-- A purchase payout is one per supplier per PR number, rebuilt from the ERP
-- purchase register (its amount is the register's own `purchaseFigures`), so
-- `purchase_key` is unique. A manual payout is anything else accounts pay.
--
-- An invoice is a row of its own because one order collects several: a
-- proforma before the goods, the tax invoice after, a debit note later. Each
-- carries the file it was read from (attachment parent `vendor_payout_invoice`).

ALTER TYPE "public"."attachment_parent" ADD VALUE IF NOT EXISTS 'vendor_payout_invoice';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_payouts" (
  "id" text PRIMARY KEY NOT NULL,
  "source" text NOT NULL,
  "purchase_key" text,
  "pr_number" integer,
  "supplier_id" text REFERENCES "erp_suppliers"("id"),
  "payee_name" text NOT NULL,
  "description" text,
  "reference" text,
  "po_id" text REFERENCES "erp_purchase_orders"("id"),
  "purchase_date" date,
  "amount_paise" bigint NOT NULL,
  "due_date" date NOT NULL,
  "pay_on" date NOT NULL,
  "pay_on_decided_at" timestamp with time zone,
  "status" text NOT NULL DEFAULT 'open',
  "hold_reason" text,
  "paid_on" date,
  "paid_amount_paise" bigint,
  "payment_mode" text,
  "payment_reference" text,
  "paid_by_id" text REFERENCES "users"("id"),
  "cancel_reason" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text,
  CONSTRAINT "vendor_payouts_source_check" CHECK ("source" in ('purchase', 'manual')),
  CONSTRAINT "vendor_payouts_status_check" CHECK ("status" in ('open', 'on_hold', 'paid', 'cancelled')),
  CONSTRAINT "vendor_payouts_amount_check" CHECK ("amount_paise" >= 0 and ("paid_amount_paise" is null or "paid_amount_paise" >= 0)),
  CONSTRAINT "vendor_payouts_purchase_key_check" CHECK (("source" = 'purchase') = ("purchase_key" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_payouts_purchase_key" ON "vendor_payouts" ("purchase_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_payouts_pay_on_idx" ON "vendor_payouts" ("status", "pay_on");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_payout_invoices" (
  "id" text PRIMARY KEY NOT NULL,
  "payout_id" text NOT NULL REFERENCES "vendor_payouts"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "invoice_no" text,
  "invoice_date" date,
  "amount_paise" bigint,
  "attachment_id" text REFERENCES "attachments"("id"),
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "vendor_payout_invoices_amount_check" CHECK ("amount_paise" is null or "amount_paise" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_payout_invoices_payout_idx" ON "vendor_payout_invoices" ("payout_id");
