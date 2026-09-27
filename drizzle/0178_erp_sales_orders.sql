-- ERP phase 4: sales orders ("Taken Order"), lot allocations ("Batch Code")
-- and order details, the billing and dispatch line (spec §11).
--
-- These are the ERP's own records. The Taken Order and Order Details sheet
-- tabs keep syncing into MahekOne until the client plans the cut-over (PRD
-- §8, open question Q1); nothing here reads or writes those synced rows.

CREATE TABLE IF NOT EXISTS "erp_orders" (
  "id" text PRIMARY KEY NOT NULL,
  "order_no" integer NOT NULL,
  "order_date" date NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "billing_customer_id" text NOT NULL REFERENCES "customers"("id"),
  "delivery_customer_id" text NOT NULL REFERENCES "customers"("id"),
  "transporter" text,
  "sku_id" text NOT NULL REFERENCES "products"("id"),
  "qty_cans" integer NOT NULL,
  "status" text DEFAULT 'Under Process' NOT NULL,
  "rate_paise" bigint,
  "discount_bp" integer,
  "tally_bill_no" text,
  "transport_cost_paise" bigint DEFAULT 0 NOT NULL,
  "remark" text,
  "entry_status" text DEFAULT 'Not Done' NOT NULL,
  -- 'Pending' when the billing party was pending on entry; 'Approved By Admin' once approved.
  "party_status" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text,
  CONSTRAINT "erp_orders_status_check" CHECK ("status" in ('Under Process', 'Ready', 'Today', 'Delay', 'Cancel', 'Tomorrow', 'Hold From Office')),
  CONSTRAINT "erp_orders_entry_check" CHECK ("entry_status" in ('Done', 'Not Done')),
  CONSTRAINT "erp_orders_qty_check" CHECK ("qty_cans" > 0)
);
CREATE INDEX IF NOT EXISTS "erp_orders_no_idx" ON "erp_orders" ("order_no");
CREATE INDEX IF NOT EXISTS "erp_orders_billing_idx" ON "erp_orders" ("billing_customer_id");

-- A lot allocated to an order line. It takes stock out of the lot the moment
-- it is written (spec §11.4); deleting it gives the stock back.
CREATE TABLE IF NOT EXISTS "erp_batch_codes" (
  "id" text PRIMARY KEY NOT NULL,
  "order_id" text NOT NULL REFERENCES "erp_orders"("id"),
  -- 'fg' draws cans from an FG lot; 'pack' draws boxes from a packing batch.
  "lot_from" text NOT NULL,
  "lot_code" text NOT NULL,
  -- The FG product of the lot, for an FG allocation (FG lots are keyed by product).
  "finished_good_id" text REFERENCES "finished_goods"("id"),
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "quantity" numeric(14, 3) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_batch_codes_from_check" CHECK ("lot_from" in ('fg', 'pack')),
  CONSTRAINT "erp_batch_codes_qty_check" CHECK ("quantity" > 0)
);
CREATE INDEX IF NOT EXISTS "erp_batch_codes_order_idx" ON "erp_batch_codes" ("order_id");
CREATE INDEX IF NOT EXISTS "erp_batch_codes_lot_idx" ON "erp_batch_codes" ("lot_from", "lot_code", "godown_id");

-- One per order line, created only by "Add To Order Details". Everything the
-- line holds is read live from it; this row holds only what dispatch adds.
CREATE TABLE IF NOT EXISTS "erp_order_details" (
  "order_id" text PRIMARY KEY NOT NULL REFERENCES "erp_orders"("id"),
  "gst_bp" integer DEFAULT 1800 NOT NULL,
  "extra_expenses_paise" bigint,
  "credit_note_paise" bigint,
  "dispatch_status" text DEFAULT 'Pending' NOT NULL,
  "dispatched_at" timestamp with time zone,
  "dispatch_date" date,
  "verification" text,
  "without_gst_paise" bigint,
  "transport_follow_up" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id" text,
  CONSTRAINT "erp_order_details_gst_check" CHECK ("gst_bp" in (0, 1800)),
  CONSTRAINT "erp_order_details_dispatch_check" CHECK ("dispatch_status" in ('Pending', 'Dispatched')),
  CONSTRAINT "erp_order_details_verify_check" CHECK ("verification" is null or "verification" in ('Verified', 'Not Verify', 'Pending'))
);
