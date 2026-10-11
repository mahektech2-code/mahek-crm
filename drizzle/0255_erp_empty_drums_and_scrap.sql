-- Empty drums, scrap sale and vendor-returnable drums. A drum is registered
-- when it becomes EMPTY — scanned off its existing GRN/lot label, weighed —
-- and from then on the database carries its GRN, supplier, material and lot
-- whatever happens to the label. Mahek-owned drums become scrap stock sold by
-- QUANTITY (oldest first); supplier-owned drums are returned to the supplier
-- by quantity (oldest first) and can never be sold. A scrap sale is a
-- receivable cleared only by an accountant matching a Petty Cash/Bank receipt
-- to it. See "## Empty drums and scrap" in AGENTS.md.

-- Who owns the drums a supplier sends: the supplier's usual answer, and the
-- answer on one GRN line (copied from the supplier when the line is saved).
-- Null on both is UNKNOWN, which is never guessed: such a drum waits for the
-- Production Head.
ALTER TABLE "erp_suppliers" ADD COLUMN IF NOT EXISTS "drum_ownership" text;
--> statement-breakpoint
ALTER TABLE "erp_suppliers" DROP CONSTRAINT IF EXISTS "erp_suppliers_drum_ownership_check";
--> statement-breakpoint
ALTER TABLE "erp_suppliers" ADD CONSTRAINT "erp_suppliers_drum_ownership_check" CHECK ("drum_ownership" is null or "drum_ownership" in ('mahek', 'returnable'));
--> statement-breakpoint
ALTER TABLE "erp_inward" ADD COLUMN IF NOT EXISTS "drum_ownership" text;
--> statement-breakpoint
ALTER TABLE "erp_inward" DROP CONSTRAINT IF EXISTS "erp_inward_drum_ownership_check";
--> statement-breakpoint
ALTER TABLE "erp_inward" ADD CONSTRAINT "erp_inward_drum_ownership_check" CHECK ("drum_ownership" is null or "drum_ownership" in ('mahek', 'returnable'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_scrap_buyers" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "phone" text,
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
  "godown_id" text REFERENCES "erp_godowns"("id"),
  "quantity" numeric(14, 3) NOT NULL,
  "unit" text NOT NULL,
  "rate_paise" bigint NOT NULL,
  "amount_paise" bigint NOT NULL,
  "ref_kind" text NOT NULL,
  "external_ref" text,
  "due_date" date,
  "remark" text,
  "status" text DEFAULT 'confirmed' NOT NULL,
  "cancel_reason" text,
  "cancelled_by_id" text REFERENCES "users"("id"),
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_scrap_sales_status_check" CHECK ("status" in ('confirmed', 'cancelled')),
  CONSTRAINT "erp_scrap_sales_qty_check" CHECK ("quantity" > 0),
  CONSTRAINT "erp_scrap_sales_amount_check" CHECK ("rate_paise" >= 0 and "amount_paise" >= 0),
  -- No external invoice is never dressed up as one: 'none' carries no reference.
  CONSTRAINT "erp_scrap_sales_ref_check" CHECK (("ref_kind" = 'none') = ("external_ref" is null) and "ref_kind" in ('invoice', 'challan', 'none')),
  CONSTRAINT "erp_scrap_sales_cancel_check" CHECK (("status" = 'cancelled') = ("cancelled_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_scrap_sales_no_key" ON "erp_scrap_sales" USING btree ("sale_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_scrap_sales_buyer_idx" ON "erp_scrap_sales" USING btree ("buyer_id", "sale_date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_drum_returns" (
  "id" text PRIMARY KEY NOT NULL,
  "return_no" integer NOT NULL,
  "supplier_id" text NOT NULL REFERENCES "erp_suppliers"("id"),
  "return_date" date NOT NULL,
  "quantity" integer NOT NULL,
  "challan_ref" text,
  "remark" text,
  "status" text DEFAULT 'confirmed' NOT NULL,
  "cancel_reason" text,
  "cancelled_by_id" text REFERENCES "users"("id"),
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_drum_returns_status_check" CHECK ("status" in ('confirmed', 'cancelled')),
  CONSTRAINT "erp_drum_returns_qty_check" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_drum_returns_no_key" ON "erp_drum_returns" USING btree ("return_no");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_drum_adjustments" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "ownership" text,
  "supplier_id" text REFERENCES "erp_suppliers"("id"),
  "godown_id" text REFERENCES "erp_godowns"("id"),
  "quantity" integer,
  "drum_id" text,
  "new_ownership" text,
  "reason" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "requested_by_id" text REFERENCES "users"("id"),
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_by_id" text REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "decision_note" text,
  "posted" jsonb,
  CONSTRAINT "erp_drum_adjustments_kind_check" CHECK ("kind" in ('opening', 'write_off', 'ownership')),
  CONSTRAINT "erp_drum_adjustments_status_check" CHECK ("status" in ('pending', 'approved', 'rejected')),
  CONSTRAINT "erp_drum_adjustments_reason_check" CHECK (length(trim("reason")) >= 10),
  CONSTRAINT "erp_drum_adjustments_shape_check" CHECK (
    ("kind" = 'ownership' and "drum_id" is not null and "new_ownership" in ('mahek', 'returnable'))
    or ("kind" in ('opening', 'write_off') and "quantity" > 0 and "ownership" in ('mahek', 'returnable')
        and ("ownership" = 'mahek' or "supplier_id" is not null))
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_drum_adjustments_status_idx" ON "erp_drum_adjustments" USING btree ("status", "requested_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_empty_drums" (
  "id" text PRIMARY KEY NOT NULL,
  "drum_no" integer NOT NULL,
  "purchase_id" text REFERENCES "erp_purchases"("id"),
  "lot_no" text,
  "inward_id" text REFERENCES "erp_inward"("id"),
  "pr_number" integer,
  "supplier_id" text REFERENCES "erp_suppliers"("id"),
  "raw_material_id" text REFERENCES "erp_raw_materials"("id"),
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "seq" integer,
  "ownership" text,
  "declared_tare_kg" numeric(10, 3),
  "actual_kg" numeric(10, 3),
  "status" text NOT NULL,
  "source" text NOT NULL,
  "review_reason" text,
  "weight_exception" text,
  "scrap_sale_id" text REFERENCES "erp_scrap_sales"("id"),
  "return_id" text REFERENCES "erp_drum_returns"("id"),
  "adjustment_id" text REFERENCES "erp_drum_adjustments"("id"),
  "client_key" text,
  "recorded_by_id" text REFERENCES "users"("id"),
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_empty_drums_status_check" CHECK ("status" in ('available', 'returnable', 'review', 'sold', 'returned', 'adjusted', 'cancelled')),
  CONSTRAINT "erp_empty_drums_ownership_check" CHECK ("ownership" is null or "ownership" in ('mahek', 'returnable')),
  CONSTRAINT "erp_empty_drums_source_check" CHECK ("source" in ('scan', 'desk', 'opening')),
  -- Only an approved opening adjustment makes a drum with no GRN behind it.
  CONSTRAINT "erp_empty_drums_link_check" CHECK ("source" = 'opening' or ("purchase_id" is not null and "lot_no" is not null and "actual_kg" is not null and "actual_kg" > 0)),
  CONSTRAINT "erp_empty_drums_stock_check" CHECK (
    ("status" <> 'available' or "ownership" = 'mahek')
    and ("status" <> 'returnable' or "ownership" = 'returnable')
    and ("status" <> 'sold' or ("ownership" = 'mahek' and "scrap_sale_id" is not null))
    and ("status" <> 'returned' or ("ownership" = 'returnable' and "return_id" is not null))
    and ("status" <> 'review' or "review_reason" is not null)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_empty_drums_no_key" ON "erp_empty_drums" USING btree ("drum_no");
--> statement-breakpoint
-- One empty record per drum of a lot: drum 3 of lot X is registered once.
CREATE UNIQUE INDEX IF NOT EXISTS "erp_empty_drums_lot_seq_key" ON "erp_empty_drums" USING btree ("purchase_id", "seq") WHERE "status" <> 'cancelled' AND "purchase_id" IS NOT NULL;
--> statement-breakpoint
-- The phone's idempotency key: a resend is answered from the first save.
CREATE UNIQUE INDEX IF NOT EXISTS "erp_empty_drums_client_key" ON "erp_empty_drums" USING btree ("client_key") WHERE "client_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_empty_drums_status_idx" ON "erp_empty_drums" USING btree ("status", "recorded_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_empty_drums_supplier_idx" ON "erp_empty_drums" USING btree ("supplier_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_drum_events" (
  "id" text PRIMARY KEY NOT NULL,
  "drum_id" text NOT NULL REFERENCES "erp_empty_drums"("id"),
  "kind" text NOT NULL,
  "from_status" text,
  "to_status" text,
  "note" text,
  "detail" jsonb,
  "by_id" text REFERENCES "users"("id"),
  "at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_drum_events_drum_idx" ON "erp_drum_events" USING btree ("drum_id", "at");
--> statement-breakpoint
-- A drum's history is appended to and never rewritten.
CREATE OR REPLACE FUNCTION "erp_drum_events_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'erp_drum_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "erp_drum_events_no_change" ON "erp_drum_events";
--> statement-breakpoint
CREATE TRIGGER "erp_drum_events_no_change" BEFORE UPDATE OR DELETE ON "erp_drum_events" FOR EACH ROW EXECUTE FUNCTION "erp_drum_events_append_only"();
--> statement-breakpoint
-- Plastic, cardboard and other scrap: recorded by category, a batch at a time.
CREATE TABLE IF NOT EXISTS "erp_scrap_entries" (
  "id" text PRIMARY KEY NOT NULL,
  "entry_date" date NOT NULL,
  "category" text NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "quantity" numeric(14, 3) NOT NULL,
  "unit" text NOT NULL,
  "note" text,
  "status" text DEFAULT 'active' NOT NULL,
  "cancel_reason" text,
  "cancelled_by_id" text REFERENCES "users"("id"),
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_scrap_entries_qty_check" CHECK ("quantity" > 0),
  CONSTRAINT "erp_scrap_entries_unit_check" CHECK ("unit" in ('Kg', 'Pcs')),
  CONSTRAINT "erp_scrap_entries_status_check" CHECK ("status" in ('active', 'cancelled'))
);
--> statement-breakpoint
-- Money received into Petty Cash/Bank from a scrap buyer, before and after it
-- is matched to the sales it pays for.
CREATE TABLE IF NOT EXISTS "erp_cash_receipts" (
  "id" text PRIMARY KEY NOT NULL,
  "receipt_no" integer NOT NULL,
  "receipt_date" date NOT NULL,
  "mode" text NOT NULL,
  "amount_paise" bigint NOT NULL,
  "buyer_id" text REFERENCES "erp_scrap_buyers"("id"),
  "payer" text,
  "reference" text,
  "note" text,
  "status" text DEFAULT 'active' NOT NULL,
  "void_reason" text,
  "voided_by_id" text REFERENCES "users"("id"),
  "voided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_cash_receipts_amount_check" CHECK ("amount_paise" > 0),
  CONSTRAINT "erp_cash_receipts_status_check" CHECK ("status" in ('active', 'void'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_cash_receipts_no_key" ON "erp_cash_receipts" USING btree ("receipt_no");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_scrap_allocations" (
  "id" text PRIMARY KEY NOT NULL,
  "receipt_id" text NOT NULL REFERENCES "erp_cash_receipts"("id"),
  "sale_id" text NOT NULL REFERENCES "erp_scrap_sales"("id"),
  "amount_paise" bigint NOT NULL,
  "by_id" text REFERENCES "users"("id"),
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "voided_at" timestamp with time zone,
  "voided_by_id" text REFERENCES "users"("id"),
  "void_reason" text,
  CONSTRAINT "erp_scrap_allocations_amount_check" CHECK ("amount_paise" > 0),
  CONSTRAINT "erp_scrap_allocations_void_check" CHECK (("voided_at" is null) = ("void_reason" is null))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_scrap_allocations_sale_idx" ON "erp_scrap_allocations" USING btree ("sale_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_scrap_allocations_receipt_idx" ON "erp_scrap_allocations" USING btree ("receipt_id");
--> statement-breakpoint
INSERT INTO "erp_series" ("key", "last") VALUES ('emptyDrum', 0), ('scrapSale', 0), ('drumReturn', 0), ('cashReceipt', 0) ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "erp_ref_values" ("id", "list_key", "value", "sort_order") VALUES
  ('erprv_scrap_plastic', 'scrapCategory', 'Plastic Scrap', 1),
  ('erprv_scrap_cardboard', 'scrapCategory', 'Cardboard/Packing Box Scrap', 2),
  ('erprv_scrap_other', 'scrapCategory', 'Other Scrap', 3)
ON CONFLICT DO NOTHING;
