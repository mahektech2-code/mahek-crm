-- THE QUOTATION MANAGER: the purchase desk's rate sheet as a grid whose rows
-- and columns are both data (see erpQuoteColumns in schema.ts). The columns
-- are seeded from the desk's own sheet so the screen opens on the shape it
-- already knows; every one of them can be renamed, moved or removed there.
CREATE TABLE IF NOT EXISTS "erp_quote_columns" (
  "id" text PRIMARY KEY NOT NULL,
  "position" integer NOT NULL,
  "pack" text DEFAULT '' NOT NULL,
  "name" text DEFAULT '' NOT NULL,
  "brand" text DEFAULT '' NOT NULL,
  "kind" text DEFAULT 'rate' NOT NULL,
  "raw_material_id" text REFERENCES "erp_raw_materials"("id"),
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_quote_columns_kind_check" CHECK ("kind" in ('rate', 'text'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_quote_columns_position_idx" ON "erp_quote_columns" ("position");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_quote_rows" (
  "id" text PRIMARY KEY NOT NULL,
  "quote_date" date NOT NULL,
  "seq" bigserial NOT NULL,
  "party" text DEFAULT '' NOT NULL,
  "supplier_id" text REFERENCES "erp_suppliers"("id"),
  "status" text,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "erp_quote_rows_status_check" CHECK ("status" is null or "status" in ('po', 'cancel', 'pickup'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_quote_rows_date_idx" ON "erp_quote_rows" ("quote_date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_quote_cells" (
  "row_id" text NOT NULL REFERENCES "erp_quote_rows"("id") ON DELETE cascade,
  "column_id" text NOT NULL REFERENCES "erp_quote_columns"("id") ON DELETE cascade,
  "value" text DEFAULT '' NOT NULL,
  "status" text,
  "updated_by_id" text REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_quote_cells_row_id_column_id_pk" PRIMARY KEY ("row_id", "column_id"),
  CONSTRAINT "erp_quote_cells_status_check" CHECK ("status" is null or "status" in ('po', 'cancel', 'pickup'))
);
--> statement-breakpoint
INSERT INTO "erp_quote_columns" ("id", "position", "pack", "name", "brand", "kind")
SELECT v.id, v.position, v.pack, v.name, v.brand, v.kind
FROM (VALUES
  ('eqc_seed_01', 1,  '185/180 KGS NET', 'Butyl Acetate No. 2', 'Mahek', 'rate'),
  ('eqc_seed_02', 2,  '172 KGS NET',     'Mix Xylene No. 7',    'Mahek', 'rate'),
  ('eqc_seed_03', 3,  '195 KG NET',      'Di Acetone No. 1',    'Mahek', 'rate'),
  ('eqc_seed_04', 4,  '200 LITER',       'Polar Thinner No. 4', 'Mahek', 'rate'),
  ('eqc_seed_05', 5,  '172 KGS NET',     'Toluene No. 5',       'Mahek', 'rate'),
  ('eqc_seed_06', 6,  '165 KGS NET',     'NBA No. 3',           'Mahek', 'rate'),
  ('eqc_seed_07', 7,  '170 KGS',         'ECA No. 9',           'Mahek', 'rate'),
  ('eqc_seed_08', 8,  '160 KGS',         'Acetone',             'Mahek', 'rate'),
  ('eqc_seed_09', 9,  '',                'TP',                  '',      'rate'),
  ('eqc_seed_10', 10, '',                'Mix',                 '',      'rate'),
  ('eqc_seed_11', 11, '',                'MDC',                 '',      'rate'),
  ('eqc_seed_12', 12, '',                'EA',                  '',      'rate'),
  ('eqc_seed_13', 13, '',                'Acetone Mix',         '',      'rate'),
  ('eqc_seed_14', 14, '',                'Extra',               'Mahek', 'rate'),
  ('eqc_seed_15', 15, '',                'Broker name',         '',      'text')
) AS v(id, position, pack, name, brand, kind)
WHERE NOT EXISTS (SELECT 1 FROM "erp_quote_columns");
