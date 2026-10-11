-- A stock check from the floor: anybody, any time, any kind of stock. The book
-- is snapshotted when the figure arrives; a mismatch waits for the office.
CREATE TABLE IF NOT EXISTS "erp_floor_checks" (
  "id" text PRIMARY KEY NOT NULL,
  "stage" text NOT NULL,
  "item_id" text NOT NULL,
  "item_name" text NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "unit" text NOT NULL,
  "counted_qty" numeric(14, 3) NOT NULL,
  "book_qty" numeric(14, 3) NOT NULL,
  "pending_in" numeric(14, 3) DEFAULT 0 NOT NULL,
  "difference" numeric(14, 3) NOT NULL,
  "tolerance" numeric(14, 3) NOT NULL,
  "matched" boolean NOT NULL,
  "reason" text,
  "bin" text,
  "source" text DEFAULT 'factory' NOT NULL,
  "client_key" text,
  "counted_by_id" text NOT NULL REFERENCES "users"("id"),
  "counted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reviewed_by_id" text REFERENCES "users"("id"),
  "reviewed_at" timestamp with time zone,
  "review_note" text,
  "stock_count_id" text REFERENCES "erp_stock_counts"("id"),
  CONSTRAINT "erp_floor_checks_stage_check" CHECK ("stage" in ('rm', 'sfg', 'fg', 'pack')),
  CONSTRAINT "erp_floor_checks_unit_check" CHECK ("unit" in ('Ltr', 'Pcs', 'Cans', 'Boxes')),
  CONSTRAINT "erp_floor_checks_source_check" CHECK ("source" in ('factory', 'erp'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_floor_checks_client_key" ON "erp_floor_checks" ("client_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_floor_checks_open_idx" ON "erp_floor_checks" ("matched", "reviewed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_floor_checks_item_idx" ON "erp_floor_checks" ("stage", "item_id", "godown_id", "counted_at");
