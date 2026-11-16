-- THE ORDER HUB (Nov 2026). Every order now starts as a TEMPORARY ORDER — a
-- TO number — wherever it was taken (the ERP form, TeleCRM, the Salesman App).
-- The back office and the Production Head both check it; the second check
-- makes the ORDER NUMBER (the `order` series, unchanged) and writes the ERP's
-- order lines. Until then nothing downstream sees it: no stock, no plan, no
-- book row, no customer message.
--
-- After the order number, two more gates before production: Accounts approve
-- every order (`accounts_check`), and the Production Head clears it against
-- materials and capacity (`production_check`). Both DEFAULT to the cleared
-- value so every line that existed before this migration keeps moving exactly
-- as it did; only orders made through the hub start Pending.
--
-- Statuses and departments are text with checks rather than enums: a value
-- added to an enum cannot be used in the transaction that adds it.

INSERT INTO "erp_series" ("key", "last") VALUES ('tempOrder', 1000) ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_order_intakes" (
  "id" text PRIMARY KEY NOT NULL,
  "to_no" integer NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "origin" text DEFAULT 'erp' NOT NULL,
  "origin_order_id" text REFERENCES "orders"("id") ON DELETE SET NULL,
  "order_source" text,
  "order_date" date NOT NULL,
  "godown_id" text REFERENCES "erp_godowns"("id"),
  "billing_customer_id" text NOT NULL REFERENCES "customers"("id"),
  "delivery_customer_id" text REFERENCES "customers"("id"),
  "transporter" text,
  "dispatch_on" date,
  "remark" text,
  "inbox_id" text,
  "taken_by_id" text REFERENCES "users"("id"),
  "back_office_by_id" text REFERENCES "users"("id"),
  "back_office_at" timestamp with time zone,
  "back_office_note" text,
  "production_by_id" text REFERENCES "users"("id"),
  "production_at" timestamp with time zone,
  "production_note" text,
  "correction_note" text,
  "correction_by_id" text REFERENCES "users"("id"),
  "correction_at" timestamp with time zone,
  "hold_reason" text,
  "hold_note" text,
  "held_by_id" text REFERENCES "users"("id"),
  "held_at" timestamp with time zone,
  "cancel_reason" text,
  "cancelled_by_id" text REFERENCES "users"("id"),
  "cancelled_at" timestamp with time zone,
  "order_no" integer,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_order_intakes_status_check" CHECK ("status" in ('open','correction','hold','verified','cancelled')),
  CONSTRAINT "erp_order_intakes_origin_check" CHECK ("origin" in ('erp','crm','mbos')),
  CONSTRAINT "erp_order_intakes_verified_has_order" CHECK ("status" <> 'verified' or "order_no" is not null),
  CONSTRAINT "erp_order_intakes_hold_has_reason" CHECK ("status" <> 'hold' or "hold_reason" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_order_intakes_to_no_key" ON "erp_order_intakes" ("to_no");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_order_intakes_order_no_key" ON "erp_order_intakes" ("order_no") WHERE "order_no" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_order_intakes_origin_order_key" ON "erp_order_intakes" ("origin_order_id") WHERE "origin_order_id" is not null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_order_intakes_open_idx" ON "erp_order_intakes" ("status", "created_at") WHERE "status" in ('open','correction','hold');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_order_intake_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "intake_id" text NOT NULL REFERENCES "erp_order_intakes"("id") ON DELETE CASCADE,
  "position" integer DEFAULT 0 NOT NULL,
  "sku_id" text NOT NULL REFERENCES "products"("id"),
  "qty_cans" integer NOT NULL,
  "rate_paise" bigint,
  "discount_bp" integer,
  "list_rate_paise" bigint,
  "rate_set_by_id" text REFERENCES "users"("id"),
  "rate_set_at" timestamp with time zone,
  "discount_authorised_by_id" text REFERENCES "users"("id"),
  "remark" text,
  CONSTRAINT "erp_order_intake_lines_qty_check" CHECK ("qty_cans" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_order_intake_lines_intake_idx" ON "erp_order_intake_lines" ("intake_id", "position");
--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN IF NOT EXISTS "intake_id" text REFERENCES "erp_order_intakes"("id");
--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN IF NOT EXISTS "accounts_check" text DEFAULT 'Approved' NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN IF NOT EXISTS "accounts_checked_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN IF NOT EXISTS "accounts_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN IF NOT EXISTS "production_check" text DEFAULT 'Cleared' NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN IF NOT EXISTS "production_checked_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN IF NOT EXISTS "production_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN IF NOT EXISTS "production_note" text;
--> statement-breakpoint
ALTER TABLE "erp_orders" ADD CONSTRAINT "erp_orders_accounts_check_check" CHECK ("accounts_check" in ('Pending','Approved','Hold','Declined'));
--> statement-breakpoint
ALTER TABLE "erp_orders" ADD CONSTRAINT "erp_orders_production_check_check" CHECK ("production_check" in ('Pending','Cleared','Hold'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_orders_gates_idx" ON "erp_orders" ("order_no") WHERE "accounts_check" <> 'Approved' or "production_check" <> 'Cleared';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_orders_intake_idx" ON "erp_orders" ("intake_id") WHERE "intake_id" is not null;
--> statement-breakpoint
-- Which desk held an order, so releasing it sends it back to that desk.
-- 'office' is every hold raised on Orders before this, and still the one
-- raised from there.
ALTER TABLE "erp_order_holds" ADD COLUMN IF NOT EXISTS "department" text DEFAULT 'office' NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_order_holds" ADD CONSTRAINT "erp_order_holds_department_check" CHECK ("department" in ('office','accounts','production'));
