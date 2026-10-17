-- ERP phase 2: numbering, requisitions, inward, testing, the purchase register
-- and the raw-material inventory log. See docs/erp/02-ERP-FUNCTIONAL-SPEC.md §5–6.

CREATE TABLE IF NOT EXISTS "erp_series" (
  "key" text PRIMARY KEY NOT NULL,
  "last" integer DEFAULT 0 NOT NULL
);
INSERT INTO "erp_series" ("key", "last") VALUES ('pr', 0), ('sfg', 0), ('fg', 0), ('packBatch', 0), ('order', 0)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS "erp_requisitions" (
  "id" text PRIMARY KEY NOT NULL,
  "req_date" date NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "material_type" text NOT NULL,
  "raw_material_id" text REFERENCES "erp_raw_materials"("id"),
  "product_id" text REFERENCES "products"("id"),
  "unit" text NOT NULL,
  "required_qty" numeric(14, 3) NOT NULL,
  "priority" text NOT NULL,
  "status" text DEFAULT 'Pending' NOT NULL,
  "remarks" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text,
  CONSTRAINT "erp_requisitions_priority_check" CHECK ("priority" in ('Urgent', 'Medium', 'For Stock')),
  CONSTRAINT "erp_requisitions_status_check" CHECK ("status" in ('Pending', 'Order Placed', 'Booked', 'Received')),
  CONSTRAINT "erp_requisitions_item_check" CHECK (num_nonnulls("raw_material_id", "product_id") = 1)
);
CREATE INDEX IF NOT EXISTS "erp_requisitions_status_idx" ON "erp_requisitions" ("status", "req_date");

CREATE TABLE IF NOT EXISTS "erp_inward" (
  "id" text PRIMARY KEY NOT NULL,
  "pr_number" integer NOT NULL,
  "received_date" date NOT NULL,
  "supplier_id" text NOT NULL REFERENCES "erp_suppliers"("id"),
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "material_type" text NOT NULL,
  "raw_material_id" text NOT NULL REFERENCES "erp_raw_materials"("id"),
  "drums" integer,
  "weight_with_drum" numeric(14, 3),
  "quantity" numeric(14, 3) NOT NULL,
  "unit" text NOT NULL,
  "remark" text,
  "testing_required" boolean NOT NULL,
  "routed" text,
  "routed_at" timestamp with time zone,
  "routed_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text,
  CONSTRAINT "erp_inward_routed_check" CHECK ("routed" is null or "routed" in ('Testing', 'Purchase'))
);
CREATE INDEX IF NOT EXISTS "erp_inward_pr_idx" ON "erp_inward" ("pr_number");

CREATE TABLE IF NOT EXISTS "erp_tests" (
  "id" text PRIMARY KEY NOT NULL,
  "inward_id" text REFERENCES "erp_inward"("id"),
  "pr_number" integer NOT NULL,
  "raw_material_id" text NOT NULL REFERENCES "erp_raw_materials"("id"),
  "supplier_id" text REFERENCES "erp_suppliers"("id"),
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "unit" text,
  "quantity" numeric(14, 3),
  "drums" integer,
  "weight_with_drum" numeric(14, 3),
  "tests" text[] DEFAULT '{}'::text[] NOT NULL,
  "ph_photo_id" text,
  "ph_value" numeric(6, 2),
  "smell" text,
  "color_photo_id" text,
  "oil_photo_id" text,
  "fast_photo_id" text,
  "nc_photo_id" text,
  "primer_photo_id" text,
  "density" numeric(8, 3),
  "density_photo_id" text,
  "thermocol_photo_id" text,
  "video_id" text,
  "tester_id" text REFERENCES "users"("id"),
  "testing_date" date NOT NULL,
  "status" text DEFAULT 'Not Verified' NOT NULL,
  "remark" text,
  "decided_by_id" text REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text,
  CONSTRAINT "erp_tests_status_check" CHECK ("status" in ('Verified', 'Not Verified'))
);
CREATE INDEX IF NOT EXISTS "erp_tests_status_idx" ON "erp_tests" ("status", "testing_date");

CREATE TABLE IF NOT EXISTS "erp_purchases" (
  "id" text PRIMARY KEY NOT NULL,
  "pr_number" integer NOT NULL,
  "purchase_date" date NOT NULL,
  "po_number" text,
  "supplier_id" text NOT NULL REFERENCES "erp_suppliers"("id"),
  "raw_material_id" text NOT NULL REFERENCES "erp_raw_materials"("id"),
  "lot_no" text NOT NULL,
  "quantity" numeric(14, 3) NOT NULL,
  "unit" text NOT NULL,
  "rate_paise" bigint,
  "density" numeric(8, 3),
  "drums" integer,
  "weight_with_drum" numeric(14, 3),
  "feed_adjusted_litre" numeric(14, 3) DEFAULT 0 NOT NULL,
  "feed_adjusted_amount_paise" bigint DEFAULT 0 NOT NULL,
  "gst_bp" integer DEFAULT 1800 NOT NULL,
  "available_litres" numeric(14, 3) DEFAULT 0 NOT NULL,
  "company" text DEFAULT 'Mahek Marketing India' NOT NULL,
  "status" text DEFAULT 'Pending' NOT NULL,
  "bill_received" text,
  "bill_number" text,
  "notes" text,
  "remark" text,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "test_id" text REFERENCES "erp_tests"("id"),
  "inward_id" text REFERENCES "erp_inward"("id"),
  "source" text NOT NULL,
  "ai_filled" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text,
  CONSTRAINT "erp_purchases_status_check" CHECK ("status" in ('Pending', 'Invoice Received', 'Purchase Matched', 'Purchase Verified')),
  CONSTRAINT "erp_purchases_unit_check" CHECK ("unit" in ('Kg', 'Litre', 'Pcs'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_purchases_lot_key" ON "erp_purchases" ("lot_no");
CREATE INDEX IF NOT EXISTS "erp_purchases_pr_idx" ON "erp_purchases" ("pr_number");
CREATE UNIQUE INDEX IF NOT EXISTS "erp_purchases_test_key" ON "erp_purchases" ("test_id");
CREATE UNIQUE INDEX IF NOT EXISTS "erp_purchases_inward_key" ON "erp_purchases" ("inward_id");

CREATE TABLE IF NOT EXISTS "erp_rm_entries" (
  "id" text PRIMARY KEY NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "entry_date" date NOT NULL,
  "raw_material_id" text NOT NULL REFERENCES "erp_raw_materials"("id"),
  "lot_no" text NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "quantity" numeric(14, 3) NOT NULL,
  "posted_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_rm_entries_source_key" ON "erp_rm_entries" ("source_type", "source_id");
CREATE INDEX IF NOT EXISTS "erp_rm_entries_lot_idx" ON "erp_rm_entries" ("lot_no", "godown_id");
