-- Scrap & empty drums: a drum is registered when it becomes EMPTY, against the
-- GRN lot it arrived in; Mahek-owned drums become scrap stock that is sold by
-- quantity (FIFO), vendor-returnable drums are pending until returned to the
-- supplier, and scrap sales are receivables the accountant matches cash/bank
-- receipts against. See "## Scrap & empty drums" in AGENTS.md.

-- Who owns a lot's drums. Null: nobody has said — a drum emptied from it waits
-- for a person to decide rather than being guessed into either stock.
ALTER TABLE "erp_purchases" ADD COLUMN IF NOT EXISTS "drum_ownership" text;
--> statement-breakpoint
ALTER TABLE "erp_purchases" ADD COLUMN IF NOT EXISTS "drum_ownership_set_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "erp_purchases" ADD COLUMN IF NOT EXISTS "drum_ownership_set_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_purchases" DROP CONSTRAINT IF EXISTS "erp_purchases_drum_ownership_check";
--> statement-breakpoint
ALTER TABLE "erp_purchases" ADD CONSTRAINT "erp_purchases_drum_ownership_check"
  CHECK ("drum_ownership" is null or "drum_ownership" in ('mahek', 'vendor'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_scrap_buyers" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "mobile" text,
  "gstin" text,
  "address" text,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_scrap_buyers_name_key" ON "erp_scrap_buyers" USING btree (lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_scrap_sales" (
  "id" text PRIMARY KEY NOT NULL,
  "sale_no" integer NOT NULL,
  "sale_date" date NOT NULL,
  "buyer_id" text NOT NULL REFERENCES "erp_scrap_buyers"("id"),
  "category" text NOT NULL,
  "category_note" text,
  "quantity" numeric(14, 3) NOT NULL,
  "unit" text NOT NULL,
  "rate_paise" bigint NOT NULL,
  "amount_paise" bigint NOT NULL,
  "invoice_kind" text NOT NULL,
  "external_ref" text,
  "due_date" date,
  "remark" text,
  "status" text DEFAULT 'active' NOT NULL,
  "cancel_reason" text,
  "cancelled_at" timestamp with time zone,
  "cancelled_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_scrap_sales_category_check" CHECK ("category" in ('drum', 'plastic', 'cardboard', 'other')),
  CONSTRAINT "erp_scrap_sales_unit_check" CHECK ("unit" in ('Drums', 'Kg', 'Bags', 'Pcs')),
  CONSTRAINT "erp_scrap_sales_qty_check" CHECK ("quantity" > 0),
  CONSTRAINT "erp_scrap_sales_amount_check" CHECK ("amount_paise" >= 0 and "rate_paise" >= 0),
  CONSTRAINT "erp_scrap_sales_invoice_check" CHECK ("invoice_kind" in ('invoice', 'none')),
  CONSTRAINT "erp_scrap_sales_invoice_ref_check" CHECK ("invoice_kind" <> 'invoice' or "external_ref" is not null),
  CONSTRAINT "erp_scrap_sales_status_check" CHECK ("status" in ('active', 'cancelled')),
  CONSTRAINT "erp_scrap_sales_drum_unit_check" CHECK (("category" = 'drum') = ("unit" = 'Drums'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_scrap_sales_no_key" ON "erp_scrap_sales" USING btree ("sale_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_scrap_sales_buyer_idx" ON "erp_scrap_sales" USING btree ("buyer_id", "sale_date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_drum_returns" (
  "id" text PRIMARY KEY NOT NULL,
  "return_no" integer NOT NULL,
  "return_date" date NOT NULL,
  "supplier_id" text NOT NULL REFERENCES "erp_suppliers"("id"),
  "quantity" integer NOT NULL,
  "challan" text,
  "remark" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_drum_returns_qty_check" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_drum_returns_no_key" ON "erp_drum_returns" USING btree ("return_no");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_empty_drums" (
  "id" text PRIMARY KEY NOT NULL,
  "drum_no" integer NOT NULL,
  "purchase_id" text NOT NULL REFERENCES "erp_purchases"("id"),
  "seq" integer NOT NULL,
  "lot_no" text NOT NULL,
  "pr_number" integer NOT NULL,
  "supplier_id" text NOT NULL REFERENCES "erp_suppliers"("id"),
  "raw_material_id" text NOT NULL REFERENCES "erp_raw_materials"("id"),
  "inward_id" text REFERENCES "erp_inward"("id"),
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "ownership" text,
  "declared_tare_kg" numeric(10, 3),
  "weight_kg" numeric(10, 3) NOT NULL,
  "first_weight_kg" numeric(10, 3) NOT NULL,
  "weight_note" text,
  "status" text NOT NULL,
  "status_note" text,
  "sale_id" text REFERENCES "erp_scrap_sales"("id"),
  "return_id" text REFERENCES "erp_drum_returns"("id"),
  "emptied_at" timestamp with time zone DEFAULT now() NOT NULL,
  "emptied_by_id" text REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_empty_drums_ownership_check" CHECK ("ownership" is null or "ownership" in ('mahek', 'vendor')),
  CONSTRAINT "erp_empty_drums_status_check" CHECK ("status" in ('available', 'returnable', 'review', 'sold', 'returned', 'cancelled')),
  CONSTRAINT "erp_empty_drums_weight_check" CHECK ("weight_kg" > 0 and "first_weight_kg" > 0),
  CONSTRAINT "erp_empty_drums_seq_check" CHECK ("seq" > 0),
  -- A status says which stock the drum is in, and only an owner can put it there.
  CONSTRAINT "erp_empty_drums_route_check" CHECK (
    ("status" in ('available', 'sold') and "ownership" = 'mahek')
    or ("status" in ('returnable', 'returned') and "ownership" = 'vendor')
    or ("status" = 'review' and "ownership" is null)
    or "status" = 'cancelled'
  ),
  CONSTRAINT "erp_empty_drums_sale_check" CHECK (("status" = 'sold') = ("sale_id" is not null)),
  CONSTRAINT "erp_empty_drums_return_check" CHECK (("status" = 'returned') = ("return_id" is not null))
);
--> statement-breakpoint
-- One empty registration per drum of a lot: a second scan of the same drum
-- cannot add it to stock twice.
CREATE UNIQUE INDEX IF NOT EXISTS "erp_empty_drums_drum_key" ON "erp_empty_drums" USING btree ("purchase_id", "seq");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_empty_drums_no_key" ON "erp_empty_drums" USING btree ("drum_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_empty_drums_status_idx" ON "erp_empty_drums" USING btree ("status", "emptied_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_empty_drums_supplier_idx" ON "erp_empty_drums" USING btree ("supplier_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_scrap_collections" (
  "id" text PRIMARY KEY NOT NULL,
  "collected_date" date NOT NULL,
  "category" text NOT NULL,
  "category_note" text,
  "quantity" numeric(14, 3) NOT NULL,
  "unit" text NOT NULL,
  "godown_id" text REFERENCES "erp_godowns"("id"),
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_scrap_collections_category_check" CHECK ("category" in ('plastic', 'cardboard', 'other')),
  CONSTRAINT "erp_scrap_collections_unit_check" CHECK ("unit" in ('Kg', 'Bags', 'Pcs')),
  CONSTRAINT "erp_scrap_collections_qty_check" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_scrap_receipts" (
  "id" text PRIMARY KEY NOT NULL,
  "receipt_no" integer NOT NULL,
  "receipt_date" date NOT NULL,
  "buyer_id" text NOT NULL REFERENCES "erp_scrap_buyers"("id"),
  "mode" text NOT NULL,
  "amount_paise" bigint NOT NULL,
  "reference" text,
  "note" text,
  "status" text DEFAULT 'active' NOT NULL,
  "void_reason" text,
  "voided_at" timestamp with time zone,
  "voided_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_scrap_receipts_mode_check" CHECK ("mode" in ('Bank', 'Cash')),
  CONSTRAINT "erp_scrap_receipts_amount_check" CHECK ("amount_paise" > 0),
  CONSTRAINT "erp_scrap_receipts_status_check" CHECK ("status" in ('active', 'void'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_scrap_receipts_no_key" ON "erp_scrap_receipts" USING btree ("receipt_no");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_scrap_allocations" (
  "id" text PRIMARY KEY NOT NULL,
  "receipt_id" text NOT NULL REFERENCES "erp_scrap_receipts"("id"),
  "sale_id" text NOT NULL REFERENCES "erp_scrap_sales"("id"),
  "amount_paise" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "voided_at" timestamp with time zone,
  "voided_by_id" text REFERENCES "users"("id"),
  "void_reason" text,
  CONSTRAINT "erp_scrap_allocations_amount_check" CHECK ("amount_paise" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_scrap_allocations_sale_idx" ON "erp_scrap_allocations" USING btree ("sale_id") WHERE "voided_at" is null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_scrap_allocations_receipt_idx" ON "erp_scrap_allocations" USING btree ("receipt_id") WHERE "voided_at" is null;
--> statement-breakpoint
INSERT INTO "erp_series" ("key", "last") VALUES ('emptyDrum', 0), ('scrapSale', 0), ('drumReturn', 0), ('scrapReceipt', 0) ON CONFLICT DO NOTHING;
