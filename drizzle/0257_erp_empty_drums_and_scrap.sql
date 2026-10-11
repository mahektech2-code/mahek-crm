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
-- 0256 shipped a first version of this module (its own tables, under the same
-- names for five of them). Those tables are set aside here, these are created,
-- and everything 0256 recorded is copied across at the end of this file, so no
-- drum, sale or receipt anybody entered is lost. Only the shape changes.
DROP INDEX IF EXISTS "erp_scrap_buyers_name_key";
--> statement-breakpoint
DROP INDEX IF EXISTS "erp_scrap_sales_no_key";
--> statement-breakpoint
DROP INDEX IF EXISTS "erp_scrap_sales_buyer_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "erp_drum_returns_no_key";
--> statement-breakpoint
DROP INDEX IF EXISTS "erp_empty_drums_drum_key";
--> statement-breakpoint
DROP INDEX IF EXISTS "erp_empty_drums_no_key";
--> statement-breakpoint
DROP INDEX IF EXISTS "erp_empty_drums_status_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "erp_empty_drums_supplier_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "erp_scrap_receipts_no_key";
--> statement-breakpoint
DROP INDEX IF EXISTS "erp_scrap_allocations_sale_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "erp_scrap_allocations_receipt_idx";
--> statement-breakpoint
ALTER TABLE IF EXISTS "erp_scrap_allocations" RENAME TO "erp_scrap_allocations_v0256";
--> statement-breakpoint
ALTER TABLE IF EXISTS "erp_scrap_allocations_v0256" RENAME CONSTRAINT "erp_scrap_allocations_pkey" TO "erp_scrap_allocations_v0256_pkey";
--> statement-breakpoint
ALTER TABLE IF EXISTS "erp_scrap_receipts" RENAME TO "erp_scrap_receipts_v0256";
--> statement-breakpoint
ALTER TABLE IF EXISTS "erp_scrap_receipts_v0256" RENAME CONSTRAINT "erp_scrap_receipts_pkey" TO "erp_scrap_receipts_v0256_pkey";
--> statement-breakpoint
ALTER TABLE IF EXISTS "erp_empty_drums" RENAME TO "erp_empty_drums_v0256";
--> statement-breakpoint
ALTER TABLE IF EXISTS "erp_empty_drums_v0256" RENAME CONSTRAINT "erp_empty_drums_pkey" TO "erp_empty_drums_v0256_pkey";
--> statement-breakpoint
ALTER TABLE IF EXISTS "erp_scrap_collections" RENAME TO "erp_scrap_collections_v0256";
--> statement-breakpoint
ALTER TABLE IF EXISTS "erp_scrap_collections_v0256" RENAME CONSTRAINT "erp_scrap_collections_pkey" TO "erp_scrap_collections_v0256_pkey";
--> statement-breakpoint
ALTER TABLE IF EXISTS "erp_drum_returns" RENAME TO "erp_drum_returns_v0256";
--> statement-breakpoint
ALTER TABLE IF EXISTS "erp_drum_returns_v0256" RENAME CONSTRAINT "erp_drum_returns_pkey" TO "erp_drum_returns_v0256_pkey";
--> statement-breakpoint
ALTER TABLE IF EXISTS "erp_scrap_sales" RENAME TO "erp_scrap_sales_v0256";
--> statement-breakpoint
ALTER TABLE IF EXISTS "erp_scrap_sales_v0256" RENAME CONSTRAINT "erp_scrap_sales_pkey" TO "erp_scrap_sales_v0256_pkey";
--> statement-breakpoint
ALTER TABLE IF EXISTS "erp_scrap_buyers" RENAME TO "erp_scrap_buyers_v0256";
--> statement-breakpoint
ALTER TABLE IF EXISTS "erp_scrap_buyers_v0256" RENAME CONSTRAINT "erp_scrap_buyers_pkey" TO "erp_scrap_buyers_v0256_pkey";
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
--> statement-breakpoint
-- ---------------------------------------------------------------- 0256's data
-- A lot's owner decided under 0256 is kept on the lot, where it still wins over
-- the GRN line and the supplier. 0256 spelled a supplier's drums 'vendor'.
ALTER TABLE "erp_purchases" ADD COLUMN IF NOT EXISTS "drum_ownership" text;
--> statement-breakpoint
ALTER TABLE "erp_purchases" ADD COLUMN IF NOT EXISTS "drum_ownership_set_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "erp_purchases" ADD COLUMN IF NOT EXISTS "drum_ownership_set_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_purchases" DROP CONSTRAINT IF EXISTS "erp_purchases_drum_ownership_check";
--> statement-breakpoint
UPDATE "erp_purchases" SET "drum_ownership" = 'returnable' WHERE "drum_ownership" = 'vendor';
--> statement-breakpoint
ALTER TABLE "erp_purchases" ADD CONSTRAINT "erp_purchases_drum_ownership_check"
  CHECK ("drum_ownership" is null or "drum_ownership" in ('mahek', 'returnable'));
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.erp_scrap_buyers_v0256') IS NULL THEN RETURN; END IF;

  INSERT INTO "erp_scrap_buyers" (id, name, phone, gstin, address, active, created_at, created_by_id)
    SELECT id, name, mobile, gstin, address, active, created_at, created_by_id FROM "erp_scrap_buyers_v0256"
    ON CONFLICT DO NOTHING;

  INSERT INTO "erp_scrap_sales" (id, sale_no, sale_date, buyer_id, category, godown_id, quantity, unit, rate_paise, amount_paise,
      ref_kind, external_ref, due_date, remark, status, cancel_reason, cancelled_by_id, cancelled_at, created_at, created_by_id)
    SELECT id, sale_no, sale_date, buyer_id,
      CASE category WHEN 'drum' THEN 'Empty Metal Drum' WHEN 'plastic' THEN 'Plastic Scrap'
        WHEN 'cardboard' THEN 'Cardboard/Packing Box Scrap' ELSE 'Other Scrap' END,
      NULL, quantity, CASE unit WHEN 'Drums' THEN 'Pcs' ELSE unit END, rate_paise, amount_paise,
      CASE WHEN invoice_kind = 'invoice' AND external_ref IS NOT NULL THEN 'invoice' ELSE 'none' END,
      CASE WHEN invoice_kind = 'invoice' THEN external_ref END,
      due_date,
      nullif(concat_ws(' · ', remark, category_note), ''),
      CASE status WHEN 'cancelled' THEN 'cancelled' ELSE 'confirmed' END,
      cancel_reason, cancelled_by_id,
      CASE WHEN status = 'cancelled' THEN coalesce(cancelled_at, created_at) END,
      created_at, created_by_id
    FROM "erp_scrap_sales_v0256"
    ON CONFLICT DO NOTHING;

  INSERT INTO "erp_drum_returns" (id, return_no, supplier_id, return_date, quantity, challan_ref, remark, status, created_at, created_by_id)
    SELECT id, return_no, supplier_id, return_date, quantity, challan, remark, 'confirmed', created_at, created_by_id
    FROM "erp_drum_returns_v0256"
    ON CONFLICT DO NOTHING;

  INSERT INTO "erp_empty_drums" (id, drum_no, purchase_id, lot_no, inward_id, pr_number, supplier_id, raw_material_id, godown_id, seq,
      ownership, declared_tare_kg, actual_kg, status, source, review_reason, scrap_sale_id, return_id, recorded_by_id, recorded_at, updated_at)
    SELECT id, drum_no, purchase_id, lot_no, inward_id, pr_number, supplier_id, raw_material_id, godown_id, seq,
      CASE ownership WHEN 'vendor' THEN 'returnable' ELSE ownership END,
      declared_tare_kg, weight_kg, status, 'scan',
      CASE WHEN status = 'review' THEN coalesce(status_note, 'Nobody recorded who owns this lot''s drums.') END,
      sale_id, return_id, emptied_by_id, emptied_at, updated_at
    FROM "erp_empty_drums_v0256"
    ON CONFLICT DO NOTHING;

  -- Each carried drum's history starts with where it came from; a weight
  -- corrected under 0256 says what it was first weighed at.
  INSERT INTO "erp_drum_events" (id, drum_id, kind, from_status, to_status, note, detail, by_id, at)
    SELECT 'dre_v0256_' || id, id, 'emptied', NULL, status,
      CASE WHEN first_weight_kg <> weight_kg
        THEN 'Recorded before this version; first weighed at ' || first_weight_kg || ' kg' || coalesce(' (' || weight_note || ')', '') || '.'
        ELSE 'Recorded before this version.' END,
      jsonb_build_object('kg', weight_kg, 'firstKg', first_weight_kg, 'source', 'v0256'),
      emptied_by_id, emptied_at
    FROM "erp_empty_drums_v0256"
    ON CONFLICT DO NOTHING;

  -- Other scrap needs a godown now; a 0256 batch that named none goes to the
  -- first godown that is not reserved, and says so.
  INSERT INTO "erp_scrap_entries" (id, entry_date, category, godown_id, quantity, unit, note, created_at, created_by_id)
    SELECT c.id, c.collected_date,
      CASE c.category WHEN 'plastic' THEN 'Plastic Scrap' WHEN 'cardboard' THEN 'Cardboard/Packing Box Scrap' ELSE 'Other Scrap' END,
      coalesce(c.godown_id, (SELECT g.id FROM "erp_godowns" g ORDER BY g.reserved, g.name LIMIT 1)),
      c.quantity, CASE c.unit WHEN 'Kg' THEN 'Kg' ELSE 'Pcs' END,
      nullif(concat_ws(' · ', c.note, c.category_note,
        CASE WHEN c.unit = 'Bags' THEN 'counted in bags' END,
        CASE WHEN c.godown_id IS NULL THEN 'no godown was recorded' END), ''),
      c.created_at, c.created_by_id
    FROM "erp_scrap_collections_v0256" c
    WHERE EXISTS (SELECT 1 FROM "erp_godowns")
    ON CONFLICT DO NOTHING;

  INSERT INTO "erp_cash_receipts" (id, receipt_no, receipt_date, mode, amount_paise, buyer_id, reference, note, status,
      void_reason, voided_by_id, voided_at, created_at, created_by_id)
    SELECT id, receipt_no, receipt_date, CASE mode WHEN 'Bank' THEN 'Bank transfer' ELSE mode END, amount_paise, buyer_id,
      reference, note, status, void_reason, voided_by_id, voided_at, created_at, created_by_id
    FROM "erp_scrap_receipts_v0256"
    ON CONFLICT DO NOTHING;

  INSERT INTO "erp_scrap_allocations" (id, receipt_id, sale_id, amount_paise, by_id, at, voided_at, voided_by_id, void_reason)
    SELECT id, receipt_id, sale_id, amount_paise, created_by_id, created_at, voided_at, voided_by_id,
      CASE WHEN voided_at IS NOT NULL THEN coalesce(void_reason, 'Voided') END
    FROM "erp_scrap_allocations_v0256"
    ON CONFLICT DO NOTHING;

  -- No number 0256 handed out is handed out again.
  UPDATE "erp_series" s SET "last" = greatest(s."last", (SELECT coalesce(max(receipt_no), 0) FROM "erp_scrap_receipts_v0256"))
    WHERE s."key" = 'cashReceipt';
  UPDATE "erp_series" s SET "last" = greatest(s."last", (SELECT coalesce(max(drum_no), 0) FROM "erp_empty_drums_v0256"))
    WHERE s."key" = 'emptyDrum';
  UPDATE "erp_series" s SET "last" = greatest(s."last", (SELECT coalesce(max(sale_no), 0) FROM "erp_scrap_sales_v0256"))
    WHERE s."key" = 'scrapSale';
  UPDATE "erp_series" s SET "last" = greatest(s."last", (SELECT coalesce(max(return_no), 0) FROM "erp_drum_returns_v0256"))
    WHERE s."key" = 'drumReturn';

  DROP TABLE "erp_scrap_allocations_v0256";
  DROP TABLE "erp_scrap_receipts_v0256";
  DROP TABLE "erp_empty_drums_v0256";
  DROP TABLE "erp_scrap_collections_v0256";
  DROP TABLE "erp_drum_returns_v0256";
  DROP TABLE "erp_scrap_sales_v0256";
  DROP TABLE "erp_scrap_buyers_v0256";
END $$;
--> statement-breakpoint
DELETE FROM "erp_series" WHERE "key" = 'scrapReceipt';
--> statement-breakpoint
-- 0256's one screen became three, and its three powers were renamed. Whoever
-- was given them keeps what they had.
INSERT INTO "app_module_access" ("id", "user_id", "app", "module", "granted_by_id", "created_at")
  SELECT m.id || '_' || x.module, m.user_id, m.app, x.module, m.granted_by_id, m.created_at
  FROM "app_module_access" m
  CROSS JOIN (VALUES ('erp.emptyDrums'), ('erp.drumReturns'), ('erp.scrapSales')) AS x(module)
  WHERE m.module = 'erp.scrap'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "app_module_access" WHERE "module" = 'erp.scrap';
--> statement-breakpoint
INSERT INTO "erp_designation_modules" ("designation_id", "module")
  SELECT d.designation_id, x.module FROM "erp_designation_modules" d
  CROSS JOIN (VALUES ('erp.emptyDrums'), ('erp.drumReturns'), ('erp.scrapSales')) AS x(module)
  WHERE d.module = 'erp.scrap'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "erp_designation_modules" WHERE "module" = 'erp.scrap';
--> statement-breakpoint
INSERT INTO "erp_user_powers" ("user_id", "power", "granted_by_id", "granted_at")
  SELECT user_id, CASE power WHEN 'scrapSell' THEN 'scrapSale' WHEN 'scrapControl' THEN 'scrapApprove' ELSE 'scrapAccounts' END,
    granted_by_id, granted_at
  FROM "erp_user_powers" WHERE "power" IN ('scrapSell', 'scrapControl', 'scrapReceipts')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "erp_user_powers" WHERE "power" IN ('scrapSell', 'scrapControl', 'scrapReceipts');
--> statement-breakpoint
INSERT INTO "erp_designation_powers" ("designation_id", "power")
  SELECT designation_id, CASE power WHEN 'scrapSell' THEN 'scrapSale' WHEN 'scrapControl' THEN 'scrapApprove' ELSE 'scrapAccounts' END
  FROM "erp_designation_powers" WHERE "power" IN ('scrapSell', 'scrapControl', 'scrapReceipts')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "erp_designation_powers" WHERE "power" IN ('scrapSell', 'scrapControl', 'scrapReceipts');
