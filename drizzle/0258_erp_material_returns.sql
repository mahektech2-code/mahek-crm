-- Material returns: vendor returns (purchase return → debit note → goods return
-- outward) and customer returns (return inward → quarantine → credit note →
-- QC disposition: reuse, rework, chemical scrap, waste). A financial document
-- never moves stock; a physical one does. See "## Material returns" in AGENTS.md.
CREATE TABLE IF NOT EXISTS "erp_purchase_returns" (
  "id" text PRIMARY KEY NOT NULL,
  "return_no" integer NOT NULL,
  "return_date" date NOT NULL,
  "purchase_id" text NOT NULL REFERENCES "erp_purchases"("id"),
  "supplier_id" text NOT NULL REFERENCES "erp_suppliers"("id"),
  "raw_material_id" text NOT NULL REFERENCES "erp_raw_materials"("id"),
  "lot_no" text NOT NULL,
  "pr_number" integer NOT NULL,
  "quantity" numeric(14, 3) NOT NULL,
  "unit" text NOT NULL,
  "stock_qty" numeric(14, 3) NOT NULL,
  "rate_paise" bigint,
  "gst_bp" integer NOT NULL DEFAULT 1800,
  "amount_paise" bigint,
  "tax_paise" bigint,
  "total_paise" bigint,
  "reason_code" text NOT NULL,
  "remarks" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "needs_owner" boolean DEFAULT false NOT NULL,
  "approved_by_id" text REFERENCES "users"("id"),
  "approved_at" timestamp with time zone,
  "owner_approved_by_id" text REFERENCES "users"("id"),
  "owner_approved_at" timestamp with time zone,
  "decision_note" text,
  "cancel_reason" text,
  "cancelled_by_id" text REFERENCES "users"("id"),
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_purchase_returns_qty_check" CHECK ("quantity" > 0 AND "stock_qty" > 0),
  CONSTRAINT "erp_purchase_returns_status_check" CHECK ("status" in ('pending', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT "erp_purchase_returns_reason_check" CHECK ("reason_code" in ('quality_defect', 'damaged', 'wrong_material', 'wrong_spec', 'other'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_purchase_returns_no_key" ON "erp_purchase_returns" USING btree ("return_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_purchase_returns_lot_idx" ON "erp_purchase_returns" USING btree ("purchase_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_debit_notes" (
  "id" text PRIMARY KEY NOT NULL,
  "note_no" integer NOT NULL,
  "note_date" date NOT NULL,
  "purchase_return_id" text NOT NULL REFERENCES "erp_purchase_returns"("id"),
  "supplier_id" text NOT NULL REFERENCES "erp_suppliers"("id"),
  "purchase_id" text NOT NULL REFERENCES "erp_purchases"("id"),
  "pr_number" integer NOT NULL,
  "bill_number" text,
  "lot_no" text NOT NULL,
  "raw_material_id" text NOT NULL REFERENCES "erp_raw_materials"("id"),
  "quantity" numeric(14, 3) NOT NULL,
  "unit" text NOT NULL,
  "rate_paise" bigint NOT NULL,
  "gst_bp" integer NOT NULL,
  "amount_paise" bigint NOT NULL,
  "tax_paise" bigint NOT NULL,
  "total_paise" bigint NOT NULL,
  "reason_code" text NOT NULL,
  "status" text DEFAULT 'issued' NOT NULL,
  "cancel_reason" text,
  "cancelled_by_id" text REFERENCES "users"("id"),
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_debit_notes_status_check" CHECK ("status" in ('issued', 'cancelled')),
  CONSTRAINT "erp_debit_notes_total_check" CHECK ("total_paise" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_debit_notes_no_key" ON "erp_debit_notes" USING btree ("note_no");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_debit_notes_live_key" ON "erp_debit_notes" USING btree ("purchase_return_id") WHERE "status" = 'issued';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_return_outwards" (
  "id" text PRIMARY KEY NOT NULL,
  "outward_no" integer NOT NULL,
  "purchase_return_id" text NOT NULL REFERENCES "erp_purchase_returns"("id"),
  "supplier_id" text NOT NULL REFERENCES "erp_suppliers"("id"),
  "raw_material_id" text NOT NULL REFERENCES "erp_raw_materials"("id"),
  "lot_no" text NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "quantity" numeric(14, 3) NOT NULL,
  "unit" text NOT NULL,
  "stock_qty" numeric(14, 3) NOT NULL,
  "packing" text,
  "transporter" text,
  "vehicle_no" text,
  "lr_no" text,
  "dispatch_date" date NOT NULL,
  "note" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "confirmed_by_id" text REFERENCES "users"("id"),
  "confirmed_at" timestamp with time zone,
  "cancel_reason" text,
  "cancelled_by_id" text REFERENCES "users"("id"),
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_return_outwards_status_check" CHECK ("status" in ('draft', 'confirmed', 'cancelled')),
  CONSTRAINT "erp_return_outwards_qty_check" CHECK ("stock_qty" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_return_outwards_no_key" ON "erp_return_outwards" USING btree ("outward_no");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_return_outwards_live_key" ON "erp_return_outwards" USING btree ("purchase_return_id") WHERE "status" <> 'cancelled';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_return_outwards_lot_idx" ON "erp_return_outwards" USING btree ("lot_no", "godown_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_customer_returns" (
  "id" text PRIMARY KEY NOT NULL,
  "return_no" integer NOT NULL,
  "return_date" date NOT NULL,
  "customer_id" text NOT NULL REFERENCES "customers"("id"),
  "order_id" text NOT NULL REFERENCES "erp_orders"("id"),
  "batch_code_id" text NOT NULL REFERENCES "erp_batch_codes"("id"),
  "sku_id" text NOT NULL REFERENCES "products"("id"),
  "finished_good_id" text REFERENCES "finished_goods"("id"),
  "lot_from" text NOT NULL,
  "lot_code" text NOT NULL,
  "quantity" numeric(14, 3) NOT NULL,
  "unit" text NOT NULL,
  "litres" numeric(14, 3) NOT NULL,
  "rate_paise" bigint,
  "discount_bp" integer,
  "gst_bp" integer NOT NULL DEFAULT 1800,
  "total_paise" bigint,
  "reason_code" text NOT NULL,
  "customer_remarks" text,
  "transporter" text,
  "vehicle_no" text,
  "lr_no" text,
  "status" text DEFAULT 'open' NOT NULL,
  "received_qty" numeric(14, 3),
  "received_godown_id" text REFERENCES "erp_godowns"("id"),
  "received_by_id" text REFERENCES "users"("id"),
  "received_at" timestamp with time zone,
  "needs_owner" boolean DEFAULT false NOT NULL,
  "approved_by_id" text REFERENCES "users"("id"),
  "approved_at" timestamp with time zone,
  "owner_approved_by_id" text REFERENCES "users"("id"),
  "owner_approved_at" timestamp with time zone,
  "complaint_id" text REFERENCES "complaints"("id"),
  "decision_note" text,
  "cancel_reason" text,
  "cancelled_by_id" text REFERENCES "users"("id"),
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_customer_returns_qty_check" CHECK ("quantity" > 0),
  CONSTRAINT "erp_customer_returns_received_check" CHECK ("received_qty" is null or ("received_qty" > 0 and "received_qty" <= "quantity")),
  CONSTRAINT "erp_customer_returns_status_check" CHECK ("status" in ('open', 'rejected', 'cancelled')),
  CONSTRAINT "erp_customer_returns_lot_check" CHECK ("lot_from" in ('fg', 'pack')),
  CONSTRAINT "erp_customer_returns_reason_check" CHECK ("reason_code" in ('quality_defect', 'damaged', 'wrong_product', 'wrong_spec', 'excess', 'other'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_customer_returns_no_key" ON "erp_customer_returns" USING btree ("return_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_customer_returns_order_idx" ON "erp_customer_returns" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_customer_returns_lot_idx" ON "erp_customer_returns" USING btree ("lot_from", "lot_code");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_return_dispositions" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_return_id" text NOT NULL REFERENCES "erp_customer_returns"("id"),
  "kind" text NOT NULL,
  "quantity" numeric(14, 3) NOT NULL,
  "litres" numeric(14, 3) NOT NULL,
  "godown_id" text REFERENCES "erp_godowns"("id"),
  "scrap_kg" numeric(14, 3),
  "scrap_entry_id" text REFERENCES "erp_scrap_entries"("id"),
  "note" text,
  "status" text DEFAULT 'active' NOT NULL,
  "decided_by_id" text REFERENCES "users"("id"),
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reverse_reason" text,
  "reversed_by_id" text REFERENCES "users"("id"),
  "reversed_at" timestamp with time zone,
  CONSTRAINT "erp_return_dispositions_kind_check" CHECK ("kind" in ('reuse', 'rework', 'scrap', 'waste')),
  CONSTRAINT "erp_return_dispositions_status_check" CHECK ("status" in ('active', 'reversed')),
  CONSTRAINT "erp_return_dispositions_qty_check" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_return_dispositions_return_idx" ON "erp_return_dispositions" USING btree ("customer_return_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_rework_orders" (
  "id" text PRIMARY KEY NOT NULL,
  "rework_no" integer NOT NULL,
  "disposition_id" text NOT NULL REFERENCES "erp_return_dispositions"("id"),
  "customer_return_id" text NOT NULL REFERENCES "erp_customer_returns"("id"),
  "formulation_id" text NOT NULL REFERENCES "product_formulations"("id"),
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "input_litres" numeric(14, 3) NOT NULL,
  "output_litres" numeric(14, 3),
  "loss_litres" numeric(14, 3),
  "sfg_lot_code" text NOT NULL,
  "operator" text,
  "rework_date" date,
  "note" text,
  "status" text DEFAULT 'open' NOT NULL,
  "completed_by_id" text REFERENCES "users"("id"),
  "completed_at" timestamp with time zone,
  "cancel_reason" text,
  "cancelled_by_id" text REFERENCES "users"("id"),
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_rework_orders_status_check" CHECK ("status" in ('open', 'completed', 'cancelled')),
  CONSTRAINT "erp_rework_orders_output_check" CHECK ("output_litres" is null or ("output_litres" >= 0 and "output_litres" <= "input_litres"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_rework_orders_no_key" ON "erp_rework_orders" USING btree ("rework_no");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_rework_orders_lot_key" ON "erp_rework_orders" USING btree ("sfg_lot_code");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_waste_disposals" (
  "id" text PRIMARY KEY NOT NULL,
  "waste_no" integer NOT NULL,
  "disposition_id" text NOT NULL REFERENCES "erp_return_dispositions"("id"),
  "customer_return_id" text NOT NULL REFERENCES "erp_customer_returns"("id"),
  "litres" numeric(14, 3) NOT NULL,
  "reason" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "disposal_date" date,
  "method" text,
  "responsible" text,
  "agency" text,
  "cost_paise" bigint,
  "note" text,
  "disposed_by_id" text REFERENCES "users"("id"),
  "disposed_at" timestamp with time zone,
  "cancel_reason" text,
  "cancelled_by_id" text REFERENCES "users"("id"),
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_waste_disposals_status_check" CHECK ("status" in ('pending', 'disposed', 'cancelled')),
  CONSTRAINT "erp_waste_disposals_cost_check" CHECK ("cost_paise" is null or "cost_paise" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_waste_disposals_no_key" ON "erp_waste_disposals" USING btree ("waste_no");
--> statement-breakpoint
INSERT INTO "erp_series" ("key", "last") VALUES ('purchaseReturn', 0), ('debitNote', 0), ('returnOutward', 0), ('customerReturn', 0), ('reworkOrder', 0), ('wasteDisposal', 0) ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "erp_ref_values" ("id", "list_key", "value", "sort_order") VALUES
  ('erprv_scrap_chemical', 'scrapCategory', 'Chemical Scrap', 4)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE IF NOT EXISTS 'erp_vendor_return';
--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE IF NOT EXISTS 'erp_customer_return';
--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE IF NOT EXISTS 'erp_waste';
