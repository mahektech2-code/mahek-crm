-- Logistics → Transport expenses (the Transportation Expense PRD).
--
-- A transporter's bill is entered once against the vehicle that carried the
-- goods, and split by litres over every PAID-freight order line that left on
-- it. The bill is Pending until somebody marks it paid, then it is history.
-- Replaces the Trips & freight and Paid freight tabs; erp_trips and the old
-- transport payments are kept as the record they are and read by nothing new.

INSERT INTO "erp_series" ("key", "last") VALUES ('freightBill', 0) ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_freight_bills" (
  "id" text PRIMARY KEY NOT NULL,
  "bill_no" integer NOT NULL,
  "lr_no" text NOT NULL,
  "bill_date" date NOT NULL,
  "transporter" text NOT NULL,
  "vehicle_no" text NOT NULL,
  "dispatch_on" date NOT NULL,
  "amount_paise" bigint NOT NULL,
  "remarks" text,
  "status" text NOT NULL DEFAULT 'pending',
  "paid_on" date,
  "payment_mode" text,
  "payment_ref" text,
  "payment_remarks" text,
  "paid_by_id" text REFERENCES "users"("id"),
  "paid_at" timestamp with time zone,
  "delete_reason" text,
  "deleted_by_id" text REFERENCES "users"("id"),
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_by_id" text REFERENCES "users"("id"),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_freight_bills_amount_check" CHECK ("amount_paise" > 0),
  CONSTRAINT "erp_freight_bills_status_check" CHECK ("status" in ('pending', 'paid', 'deleted')),
  CONSTRAINT "erp_freight_bills_mode_check" CHECK ("payment_mode" is null or "payment_mode" in ('bank', 'upi', 'cash')),
  CONSTRAINT "erp_freight_bills_paid_check" CHECK (("status" = 'paid') = ("paid_on" is not null and "payment_mode" is not null and "paid_at" is not null))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_freight_bills_no_key" ON "erp_freight_bills" ("bill_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_freight_bills_status_idx" ON "erp_freight_bills" ("status", "bill_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_freight_bills_vehicle_idx" ON "erp_freight_bills" ("dispatch_on", upper("vehicle_no"));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_freight_bill_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "bill_id" text NOT NULL REFERENCES "erp_freight_bills"("id"),
  "order_id" text NOT NULL REFERENCES "erp_orders"("id"),
  "transport_id" text REFERENCES "erp_transports"("id"),
  "litres" numeric(12, 3) NOT NULL,
  "amount_paise" bigint NOT NULL,
  "live" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "erp_freight_bill_lines_litres_check" CHECK ("litres" > 0),
  CONSTRAINT "erp_freight_bill_lines_amount_check" CHECK ("amount_paise" >= 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_freight_bill_lines_bill_idx" ON "erp_freight_bill_lines" ("bill_id");--> statement-breakpoint
-- An order line carries at most one live share, so the same freight cannot reach it twice.
CREATE UNIQUE INDEX IF NOT EXISTS "erp_freight_bill_lines_live_key" ON "erp_freight_bill_lines" ("order_id") WHERE "live";--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_freight_bill_events" (
  "id" text PRIMARY KEY NOT NULL,
  "bill_id" text NOT NULL REFERENCES "erp_freight_bills"("id"),
  "kind" text NOT NULL,
  "note" text,
  "by_id" text REFERENCES "users"("id"),
  "at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "erp_freight_bill_events_kind_check" CHECK ("kind" in ('created', 'edited', 'split', 'paid', 'unpaid', 'deleted'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_freight_bill_events_bill_idx" ON "erp_freight_bill_events" ("bill_id", "at");
