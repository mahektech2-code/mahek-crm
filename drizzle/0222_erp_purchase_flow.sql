-- THE PURCHASE FLOW: Requirement → Purchase method → Vendor / Quotation →
-- Approval → PO → Receipt. No purchase is completed without a PO, and a
-- quotation is required only where the item's purchase rule says so.

-- The purchase rule on the item master, and the vendor a direct purchase offers first.
ALTER TABLE "erp_raw_materials" ADD COLUMN IF NOT EXISTS "purchase_method" text DEFAULT 'direct' NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_raw_materials" ADD COLUMN IF NOT EXISTS "preferred_supplier_id" text REFERENCES "erp_suppliers"("id");
--> statement-breakpoint
ALTER TABLE "erp_raw_materials" DROP CONSTRAINT IF EXISTS "erp_raw_materials_purchase_method_check";
--> statement-breakpoint
ALTER TABLE "erp_raw_materials" ADD CONSTRAINT "erp_raw_materials_purchase_method_check" CHECK ("purchase_method" in ('direct', 'quotation', 'buyer'));
--> statement-breakpoint
-- Chemicals are the price-sensitive buys and start on quotation; boxes, cans,
-- drums and stationery are routine and start direct. Each item can be changed
-- on the Raw materials screen.
UPDATE "erp_raw_materials" SET "purchase_method" = 'quotation' WHERE "material_type" = 'Chemical' AND "purchase_method" = 'direct';
--> statement-breakpoint

-- The requirement: who needs it, by when, and how it is being bought.
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "department" text;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "required_by" date;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "purchase_rule" text;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "method" text;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "method_decided_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "method_decided_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "method_note" text;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "supplier_id" text REFERENCES "erp_suppliers"("id");
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "quotation_id" text;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "vendor_selected_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "vendor_selected_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "selection_note" text;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "cancel_reason" text;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" DROP CONSTRAINT IF EXISTS "erp_requisitions_status_check";
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD CONSTRAINT "erp_requisitions_status_check" CHECK ("status" in ('Pending', 'Order Placed', 'Booked', 'Received', 'Cancelled'));
--> statement-breakpoint
ALTER TABLE "erp_requisitions" DROP CONSTRAINT IF EXISTS "erp_requisitions_rule_check";
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD CONSTRAINT "erp_requisitions_rule_check" CHECK ("purchase_rule" is null or "purchase_rule" in ('direct', 'quotation', 'buyer'));
--> statement-breakpoint
ALTER TABLE "erp_requisitions" DROP CONSTRAINT IF EXISTS "erp_requisitions_method_check";
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD CONSTRAINT "erp_requisitions_method_check" CHECK ("method" is null or "method" in ('direct', 'quotation'));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_quotations" (
  "id" text PRIMARY KEY NOT NULL,
  "requisition_id" text NOT NULL REFERENCES "erp_requisitions"("id") ON DELETE cascade,
  "supplier_id" text NOT NULL REFERENCES "erp_suppliers"("id"),
  "quote_date" date NOT NULL,
  "reference" text,
  "rate_paise" bigint NOT NULL,
  "gst_bp" integer DEFAULT 1800 NOT NULL,
  "freight_paise" bigint DEFAULT 0 NOT NULL,
  "delivery_days" integer,
  "payment_terms" text,
  "valid_until" date,
  "document_id" text,
  "remarks" text,
  "status" text DEFAULT 'Received' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text,
  CONSTRAINT "erp_quotations_status_check" CHECK ("status" in ('Received', 'Selected', 'Not selected')),
  CONSTRAINT "erp_quotations_amounts_check" CHECK ("rate_paise" > 0 and "freight_paise" >= 0 and "gst_bp" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_quotations_vendor_key" ON "erp_quotations" ("requisition_id", "supplier_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_quotations_selected_key" ON "erp_quotations" ("requisition_id") WHERE "status" = 'Selected';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_purchase_orders" (
  "id" text PRIMARY KEY NOT NULL,
  "po_number" integer NOT NULL,
  "po_date" date NOT NULL,
  "supplier_id" text NOT NULL REFERENCES "erp_suppliers"("id"),
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "delivery_date" date NOT NULL,
  "payment_terms" text NOT NULL,
  "freight_paise" bigint DEFAULT 0 NOT NULL,
  "remarks" text,
  "status" text DEFAULT 'Pending approval' NOT NULL,
  "approved_by_id" text REFERENCES "users"("id"),
  "approved_at" timestamp with time zone,
  "decision_note" text,
  "sent_at" timestamp with time zone,
  "sent_by_id" text REFERENCES "users"("id"),
  "sent_via" text,
  "close_reason" text,
  "closed_at" timestamp with time zone,
  "closed_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text,
  CONSTRAINT "erp_purchase_orders_status_check" CHECK ("status" in ('Pending approval', 'Approved', 'Sent', 'Partly received', 'Received', 'Closed', 'Cancelled', 'Rejected')),
  CONSTRAINT "erp_purchase_orders_freight_check" CHECK ("freight_paise" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_purchase_orders_number_key" ON "erp_purchase_orders" ("po_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_purchase_orders_status_idx" ON "erp_purchase_orders" ("status", "po_date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_po_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "po_id" text NOT NULL REFERENCES "erp_purchase_orders"("id") ON DELETE cascade,
  "requisition_id" text NOT NULL REFERENCES "erp_requisitions"("id"),
  "raw_material_id" text NOT NULL REFERENCES "erp_raw_materials"("id"),
  "quantity" numeric(14, 3) NOT NULL,
  "unit" text NOT NULL,
  "rate_paise" bigint NOT NULL,
  "gst_bp" integer DEFAULT 1800 NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "erp_po_lines_amounts_check" CHECK ("quantity" > 0 and "rate_paise" > 0 and "gst_bp" >= 0),
  CONSTRAINT "erp_po_lines_unit_check" CHECK ("unit" in ('Kg', 'Litre', 'Pcs'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_po_lines_po_idx" ON "erp_po_lines" ("po_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_po_lines_requisition_idx" ON "erp_po_lines" ("requisition_id");
--> statement-breakpoint

-- What arrived, and what was registered, names the PO line it was bought on.
ALTER TABLE "erp_inward" ADD COLUMN IF NOT EXISTS "po_id" text REFERENCES "erp_purchase_orders"("id");
--> statement-breakpoint
ALTER TABLE "erp_inward" ADD COLUMN IF NOT EXISTS "po_line_id" text REFERENCES "erp_po_lines"("id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_inward_po_line_idx" ON "erp_inward" ("po_line_id");
--> statement-breakpoint
ALTER TABLE "erp_purchases" ADD COLUMN IF NOT EXISTS "po_id" text REFERENCES "erp_purchase_orders"("id");
--> statement-breakpoint
ALTER TABLE "erp_purchases" ADD COLUMN IF NOT EXISTS "po_line_id" text REFERENCES "erp_po_lines"("id");
--> statement-breakpoint

INSERT INTO "erp_series" ("key", "last") VALUES ('po', 0) ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "erp_ref_values" ("id", "list_key", "value", "sort_order") VALUES
  ('erprv_dept_production', 'department', 'Production', 1),
  ('erprv_dept_store', 'department', 'Godown / Store', 2),
  ('erprv_dept_quality', 'department', 'Quality', 3),
  ('erprv_dept_packing', 'department', 'Packing', 4),
  ('erprv_dept_dispatch', 'department', 'Dispatch', 5),
  ('erprv_dept_office', 'department', 'Office', 6),
  ('erprv_dept_maintenance', 'department', 'Maintenance', 7),
  ('erprv_pt_advance', 'paymentTerms', 'Advance', 1),
  ('erprv_pt_delivery', 'paymentTerms', 'Against delivery', 2),
  ('erprv_pt_7', 'paymentTerms', '7 days credit', 3),
  ('erprv_pt_15', 'paymentTerms', '15 days credit', 4),
  ('erprv_pt_30', 'paymentTerms', '30 days credit', 5),
  ('erprv_pt_45', 'paymentTerms', '45 days credit', 6),
  ('erprv_pt_60', 'paymentTerms', '60 days credit', 7)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE IF NOT EXISTS 'erp_quotation';
--> statement-breakpoint

-- The new Purchase orders screen reaches everybody who could already raise a
-- requirement. A whole-ERP grant (no module rows) reaches it on its own; a
-- NARROWED one that held requisitions gains it, and so do the designations
-- built on that screen — so nobody holding one becomes "customised".
INSERT INTO "app_module_access" ("id", "user_id", "app", "module")
SELECT 'amg_' || substr(md5(m.user_id || 'erp.purchaseOrders'), 1, 20), m.user_id, m.app, 'erp.purchaseOrders'
  FROM "app_module_access" m
 WHERE m.app::text = 'erp' AND m.module = 'erp.requisitions'
   AND NOT EXISTS (SELECT 1 FROM "app_module_access" x WHERE x.user_id = m.user_id AND x.module = 'erp.purchaseOrders');
--> statement-breakpoint
INSERT INTO "erp_designation_modules" ("designation_id", "module")
SELECT d.designation_id, 'erp.purchaseOrders' FROM "erp_designation_modules" d WHERE d.module = 'erp.requisitions'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "erp_designation_modules" ("designation_id", "module") VALUES ('erpd_office', 'erp.purchaseOrders'), ('erpd_office', 'erp.requisitions')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- (The app is copied from the person's own ERP row and compared as text: on a
-- fresh database the enum value was added in this same transaction, and
-- Postgres refuses to read a new enum value as a literal before it commits.)
INSERT INTO "app_module_access" ("id", "user_id", "app", "module")
SELECT DISTINCT ON (u.user_id, mod.module) 'amg_' || substr(md5(u.user_id || mod.module), 1, 20), u.user_id, y.app, mod.module
  FROM "erp_user_designations" u
  JOIN "app_module_access" y ON y.user_id = u.user_id AND y.app::text = 'erp'
 CROSS JOIN (VALUES ('erp.purchaseOrders'), ('erp.requisitions')) AS mod(module)
 WHERE u.designation_id = 'erpd_office'
   AND NOT EXISTS (SELECT 1 FROM "app_module_access" x WHERE x.user_id = u.user_id AND x.module = mod.module);
--> statement-breakpoint
-- The two new powers: the buyer (decides Buyer-decision requirements) and the
-- PO approver. The office buys; the admin designation approves.
INSERT INTO "erp_designation_powers" ("designation_id", "power") VALUES
  ('erpd_admin', 'approvePurchaseOrder'), ('erpd_admin', 'purchaseBuyer'), ('erpd_office', 'purchaseBuyer')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "erp_user_powers" ("user_id", "power")
SELECT u.user_id, p.power FROM "erp_user_designations" u
  JOIN "erp_designation_powers" p ON p.designation_id = u.designation_id AND p.power in ('approvePurchaseOrder', 'purchaseBuyer')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "erp_designations" SET "description" = 'Purchase requirements, purchase orders and their quotations, buyer decisions, purchase and order money, Tally bill numbers, customer status, dispatch verification and freight.'
 WHERE "id" = 'erpd_office' AND "updated_by_id" IS NULL;
--> statement-breakpoint
UPDATE "erp_designations" SET "description" = 'Purchase requirements, purchase orders, goods receipt against a PO, the purchase register, drum barcodes and raw-material stock.'
 WHERE "id" = 'erpd_store' AND "updated_by_id" IS NULL;
