-- ERP phase 1: godowns, who works where, the ERP's per-person powers, the
-- editable reference lists, raw materials, suppliers, and the SKU and
-- customer fields MahekOne never held. See docs/erp/02-ERP-FUNCTIONAL-SPEC.md.

CREATE TABLE IF NOT EXISTS "erp_godowns" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "city" text,
  "state" text,
  "region" text,
  "address" text,
  "phone" text,
  "gstin" text,
  "email" text,
  "status" text DEFAULT 'active' NOT NULL,
  "remark" text,
  "lat" double precision,
  "lng" double precision,
  "reserved" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text,
  CONSTRAINT "erp_godowns_status_check" CHECK ("status" in ('active', 'inactive'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_godowns_name_key" ON "erp_godowns" ("name");

CREATE TABLE IF NOT EXISTS "erp_godown_staff" (
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_godown_staff_pk" PRIMARY KEY ("godown_id", "user_id")
);

CREATE TABLE IF NOT EXISTS "erp_user_settings" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "working_godown_id" text REFERENCES "erp_godowns"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "erp_user_powers" (
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "power" text NOT NULL,
  "granted_by_id" text REFERENCES "users"("id"),
  "granted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_user_powers_pk" PRIMARY KEY ("user_id", "power")
);

CREATE TABLE IF NOT EXISTS "erp_ref_values" (
  "id" text PRIMARY KEY NOT NULL,
  "list_key" text NOT NULL,
  "value" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_ref_values_list_value_key" ON "erp_ref_values" ("list_key", "value");

CREATE TABLE IF NOT EXISTS "erp_raw_materials" (
  "id" text PRIMARY KEY NOT NULL,
  "serial_no" integer NOT NULL,
  "name" text NOT NULL,
  "code" text,
  "unit" text NOT NULL,
  "material_type" text NOT NULL,
  "density" numeric(8, 3),
  "testing_list" text[] DEFAULT '{}'::text[] NOT NULL,
  "price_paise" bigint,
  "remark" text,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text,
  CONSTRAINT "erp_raw_materials_unit_check" CHECK ("unit" in ('Kg', 'Litre', 'Unit'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_raw_materials_name_key" ON "erp_raw_materials" ("name");
CREATE UNIQUE INDEX IF NOT EXISTS "erp_raw_materials_serial_key" ON "erp_raw_materials" ("serial_no");

CREATE TABLE IF NOT EXISTS "erp_suppliers" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "party_code" text,
  "area" text,
  "location" text,
  "state" text,
  "credit_days" integer,
  "mobile" text,
  "whatsapp" text,
  "broker" text,
  "grade" text,
  "email" text,
  "gstin" text,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_suppliers_name_key" ON "erp_suppliers" ("name");

CREATE TABLE IF NOT EXISTS "erp_product_packing" (
  "product_id" text PRIMARY KEY NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "can_use_material_id" text REFERENCES "erp_raw_materials"("id"),
  "empty_boxes_required" integer DEFAULT 0 NOT NULL,
  "box_type" text,
  "box_rate_paise" bigint,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id" text
);

CREATE TABLE IF NOT EXISTS "erp_customer_profiles" (
  "customer_id" text PRIMARY KEY NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "state" text,
  "transporter" text,
  "weight_type" text,
  "segment" text,
  "counter_types" text[] DEFAULT '{}'::text[] NOT NULL,
  "grade" text,
  "standing_instructions" text,
  "allocate_email" text,
  "monthly_target_paise" bigint,
  "pending_activation" boolean DEFAULT false NOT NULL,
  "activated_at" timestamp with time zone,
  "activated_by_id" text REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id" text
);

-- The loss ledger is a real godown, reserved. Bhiwandi and Ambernath are the
-- two godowns the source names in its own enums; the rest are registered on
-- the Godowns screen.
INSERT INTO "erp_godowns" ("id", "name", "city", "state", "region", "status", "reserved")
VALUES
  ('erpg_item_lost_record', 'Item Lost Record', NULL, NULL, NULL, 'active', true),
  ('erpg_bhiwandi', 'Bhiwandi', 'Bhiwandi', 'Maharashtra', 'West', 'active', false),
  ('erpg_ambernath', 'Ambernath', 'Ambernath', 'Maharashtra', 'West', 'active', false)
ON CONFLICT DO NOTHING;

-- The fixed and seed values of the editable lists (spec §3). Open lists the
-- source kept in its sheets are filled from migrated data, not guessed here.
INSERT INTO "erp_ref_values" ("id", "list_key", "value", "sort_order") VALUES
  ('erprv_mt_chemical', 'materialType', 'Chemical', 1),
  ('erprv_mt_can', 'materialType', 'Can', 2),
  ('erprv_mt_drum', 'materialType', 'Drum', 3),
  ('erprv_mt_box', 'materialType', 'Box', 4),
  ('erprv_mt_stationary', 'materialType', 'Stationary', 5),
  ('erprv_tl_ph', 'testingList', 'PH', 1),
  ('erprv_tl_smell', 'testingList', 'Smell', 2),
  ('erprv_tl_color', 'testingList', 'Color', 3),
  ('erprv_tl_oil', 'testingList', 'Oil Paint', 4),
  ('erprv_tl_fast', 'testingList', 'Fast Paints', 5),
  ('erprv_tl_nc', 'testingList', 'Nc Paints', 6),
  ('erprv_tl_primer', 'testingList', 'Primer', 7),
  ('erprv_tl_density', 'testingList', 'Density', 8),
  ('erprv_tl_thermocol', 'testingList', 'Tharmakol Pass', 9),
  ('erprv_ct_packaging', 'complaintType', 'Packaging', 1),
  ('erprv_ct_staff', 'complaintType', 'Staff', 2),
  ('erprv_ct_product', 'complaintType', 'Product', 3),
  ('erprv_ct_transport', 'complaintType', 'Transport', 4),
  ('erprv_ct_rate', 'complaintType', 'Rate Discount', 5),
  ('erprv_ct_payment', 'complaintType', 'Immediate Payment', 6),
  ('erprv_ct_transportation', 'complaintType', 'Transportation', 7),
  ('erprv_ct_product_complain', 'complaintType', 'Product Complain', 8),
  ('erprv_ct_promotion', 'complaintType', 'Sales Promotion', 9),
  ('erprv_sl_toluene', 'shortLabel', 'Toulene=Stoving', 1),
  ('erprv_sl_acetone_mix', 'shortLabel', 'Acetone Mix=Acet Mix', 2),
  ('erprv_sl_acetone', 'shortLabel', 'Acetone=Acet', 3)
ON CONFLICT DO NOTHING;
