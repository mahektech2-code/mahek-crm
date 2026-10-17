-- ERP phase 3: semi-finished batches, finished-goods filling, FG packing,
-- item transfers and re-order levels (spec §7–§10).
--
-- Each stage keeps an inflow ledger (erp_*_entries), one entry per source
-- document. Outflows are never entries: they are read from the documents
-- that consume stock (spec §6.1).

CREATE TABLE IF NOT EXISTS "erp_transfers" (
  "id" text PRIMARY KEY NOT NULL,
  "transfer_date" date NOT NULL,
  "item_type" text NOT NULL,
  "from_godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "to_godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  -- A raw material, a formulation, a finished good or an SKU, by item_type.
  "item_id" text NOT NULL,
  "item_name" text NOT NULL,
  "lot_no" text NOT NULL,
  "quantity" numeric(14, 3) NOT NULL,
  "remark" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_transfers_type_check" CHECK ("item_type" in ('Purchase', 'Semi Finished', 'Finish Goods', 'FG Packing')),
  CONSTRAINT "erp_transfers_places_check" CHECK ("from_godown_id" <> "to_godown_id"),
  CONSTRAINT "erp_transfers_quantity_check" CHECK ("quantity" > 0)
);
CREATE INDEX IF NOT EXISTS "erp_transfers_out_idx" ON "erp_transfers" ("item_type", "lot_no", "from_godown_id");

CREATE TABLE IF NOT EXISTS "erp_sfg_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "sfg_no" integer NOT NULL,
  "batch_date" date NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "formulation_id" text NOT NULL REFERENCES "product_formulations"("id"),
  "batches" numeric(10, 2) NOT NULL,
  "raw_material_id" text NOT NULL REFERENCES "erp_raw_materials"("id"),
  "rm_lot_no" text NOT NULL,
  "qty_per_batch" numeric(14, 3) NOT NULL,
  -- batches × qty_per_batch, written with the line and never on its own.
  "total_use" numeric(14, 3) NOT NULL,
  "litres_adjusted" numeric(14, 3) DEFAULT 0 NOT NULL,
  "lot_code" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text,
  CONSTRAINT "erp_sfg_lines_use_check" CHECK ("total_use" > 0)
);
CREATE INDEX IF NOT EXISTS "erp_sfg_lines_rm_idx" ON "erp_sfg_lines" ("rm_lot_no", "godown_id");
CREATE INDEX IF NOT EXISTS "erp_sfg_lines_no_idx" ON "erp_sfg_lines" ("sfg_no");

CREATE TABLE IF NOT EXISTS "erp_sfg_entries" (
  "id" text PRIMARY KEY NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "entry_date" date NOT NULL,
  "formulation_id" text NOT NULL REFERENCES "product_formulations"("id"),
  "lot_code" text NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "quantity" numeric(14, 3) NOT NULL,
  "batches" numeric(10, 2),
  "remark" text,
  "posted_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_sfg_entries_source_key" ON "erp_sfg_entries" ("source_type", "source_id");
CREATE INDEX IF NOT EXISTS "erp_sfg_entries_lot_idx" ON "erp_sfg_entries" ("lot_code", "godown_id");

CREATE TABLE IF NOT EXISTS "erp_fg_fills" (
  "id" text PRIMARY KEY NOT NULL,
  "fg_num" integer NOT NULL,
  "fill_date" date NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "formulation_id" text NOT NULL REFERENCES "product_formulations"("id"),
  "sfg_lot_code" text NOT NULL,
  "finished_good_id" text NOT NULL REFERENCES "finished_goods"("id"),
  "can_size" numeric(8, 3) NOT NULL,
  "can_use_id" text REFERENCES "erp_raw_materials"("id"),
  "packing_type" text NOT NULL,
  "cans" integer NOT NULL,
  "can_adjusted" integer DEFAULT 0 NOT NULL,
  "lot_code" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text,
  CONSTRAINT "erp_fg_fills_packing_check" CHECK ("packing_type" in ('Can', 'Drum', 'Naket')),
  CONSTRAINT "erp_fg_fills_cans_check" CHECK ("cans" > 0 and "can_adjusted" >= 0 and "can_adjusted" <= "cans")
);
CREATE INDEX IF NOT EXISTS "erp_fg_fills_sfg_idx" ON "erp_fg_fills" ("sfg_lot_code", "godown_id");

CREATE TABLE IF NOT EXISTS "erp_fg_entries" (
  "id" text PRIMARY KEY NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "entry_date" date NOT NULL,
  "finished_good_id" text NOT NULL REFERENCES "finished_goods"("id"),
  "lot_code" text NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "quantity" numeric(14, 3) NOT NULL,
  "can_use_id" text REFERENCES "erp_raw_materials"("id"),
  "packing_type" text,
  -- The loose SKU these cans sell as (spec §8.2 "Description Of Goods").
  "sku_id" text REFERENCES "products"("id"),
  "posted_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_fg_entries_source_key" ON "erp_fg_entries" ("source_type", "source_id");
CREATE INDEX IF NOT EXISTS "erp_fg_entries_lot_idx" ON "erp_fg_entries" ("lot_code", "godown_id");

CREATE TABLE IF NOT EXISTS "erp_pack_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "batch_serial" integer NOT NULL,
  "batch_no" text NOT NULL,
  "pack_date" date NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "finished_good_id" text NOT NULL REFERENCES "finished_goods"("id"),
  "sku_id" text NOT NULL REFERENCES "products"("id"),
  -- Boxes in the WHOLE batch, carried on every line (spec §9.1).
  "boxes" integer NOT NULL,
  "fg_lot_code" text NOT NULL,
  -- Cans taken from this line's FG lot.
  "cans" integer NOT NULL,
  "remarks" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text,
  CONSTRAINT "erp_pack_lines_qty_check" CHECK ("boxes" > 0 and "cans" > 0)
);
CREATE INDEX IF NOT EXISTS "erp_pack_lines_batch_idx" ON "erp_pack_lines" ("batch_no");
CREATE INDEX IF NOT EXISTS "erp_pack_lines_fg_idx" ON "erp_pack_lines" ("fg_lot_code", "godown_id");

-- One entry per COMPLETE batch (spec §14 A-15), never one per line.
CREATE TABLE IF NOT EXISTS "erp_pack_entries" (
  "id" text PRIMARY KEY NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "entry_date" date NOT NULL,
  "sku_id" text NOT NULL REFERENCES "products"("id"),
  "batch_no" text NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "boxes" numeric(14, 3) NOT NULL,
  "posted_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_pack_entries_source_key" ON "erp_pack_entries" ("source_type", "source_id");
CREATE INDEX IF NOT EXISTS "erp_pack_entries_batch_idx" ON "erp_pack_entries" ("batch_no", "godown_id");

CREATE TABLE IF NOT EXISTS "erp_rm_levels" (
  "id" text PRIMARY KEY NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "material_type" text NOT NULL,
  "raw_material_id" text NOT NULL REFERENCES "erp_raw_materials"("id"),
  "min_qty" numeric(14, 3) NOT NULL,
  "max_qty" numeric(14, 3) NOT NULL,
  "status" text DEFAULT 'Follow' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_rm_levels_status_check" CHECK ("status" in ('Follow', 'UnFollow'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_rm_levels_key" ON "erp_rm_levels" ("godown_id", "raw_material_id");

CREATE TABLE IF NOT EXISTS "erp_fg_levels" (
  "id" text PRIMARY KEY NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "product_id" text NOT NULL REFERENCES "products"("id"),
  "min_qty" numeric(14, 3) NOT NULL,
  "status" text DEFAULT 'Follow' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_fg_levels_status_check" CHECK ("status" in ('Follow', 'UnFollow'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_fg_levels_key" ON "erp_fg_levels" ("godown_id", "product_id");
