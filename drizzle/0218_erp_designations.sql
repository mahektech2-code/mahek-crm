-- ERP designations: a named, LINKED shape of ERP access (level, screens,
-- powers). Seeded with the ten the ERP design previews access as.
CREATE TABLE IF NOT EXISTS "erp_designations" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "level" text DEFAULT 'associate' NOT NULL,
  "all_screens" boolean DEFAULT false NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id" text REFERENCES "users"("id") ON DELETE set null,
  CONSTRAINT "erp_designations_level_check" CHECK ("level" in ('associate', 'manager', 'admin'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_designations_name_key" ON "erp_designations" ("name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_designation_modules" (
  "designation_id" text NOT NULL REFERENCES "erp_designations"("id") ON DELETE cascade,
  "module" text NOT NULL,
  CONSTRAINT "erp_designation_modules_pk" PRIMARY KEY ("designation_id", "module")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_designation_powers" (
  "designation_id" text NOT NULL REFERENCES "erp_designations"("id") ON DELETE cascade,
  "power" text NOT NULL,
  CONSTRAINT "erp_designation_powers_pk" PRIMARY KEY ("designation_id", "power")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_user_designations" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "designation_id" text NOT NULL REFERENCES "erp_designations"("id") ON DELETE restrict,
  "assigned_by_id" text REFERENCES "users"("id") ON DELETE set null,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "erp_designations" ("id", "name", "description", "level", "all_screens", "sort_order") VALUES
  ('erpd_ceo', 'Owner / CEO', 'Every screen and every power. The only person who verifies a purchase test, sets Purchase Verified and writes stock off to Item Lost Record.', 'admin', true, 10),
  ('erpd_admin', 'Admin', 'Every screen. Sees every rate, cost and margin, reopens verified purchases, approves pending customers, decides requests and administers godowns and powers.', 'manager', true, 20),
  ('erpd_office', 'Office / accounts', 'Purchase and order money, Tally bill numbers, customer status, dispatch verification and freight.', 'manager', false, 30),
  ('erpd_store', 'Purchase / store', 'Requisitions, goods inward, the purchase register, drum barcodes and raw-material stock.', 'associate', false, 40),
  ('erpd_tester', 'Quality tester', 'Records purchase tests with photographs, a video and readings.', 'associate', false, 50),
  ('erpd_production', 'Production', 'SFG batches, FG filling and FG packing, and the stock they post to.', 'associate', false, 60),
  ('erpd_godown', 'Godown / dispatch', 'Allocates lot codes to orders, marks them ready, prints labels and transfers stock.', 'associate', false, 70),
  ('erpd_orderdesk', 'Order desk', 'Enters taken orders and manages their status, with the sales rate.', 'associate', false, 80),
  ('erpd_logistics', 'Logistics', 'LR numbers, consignment tracking and freight.', 'associate', false, 90),
  ('erpd_sales', 'Sales person', 'Raises complaints and credit-note requests, and keeps their own customers up to date.', 'associate', false, 100)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "erp_designation_modules" ("designation_id", "module") VALUES
  ('erpd_office', 'erp.alerts'), ('erpd_office', 'erp.orders'), ('erpd_office', 'erp.customers'), ('erpd_office', 'erp.suppliers'),
  ('erpd_office', 'erp.register'), ('erpd_office', 'erp.transport'), ('erpd_office', 'erp.requests'), ('erpd_office', 'erp.expenses'),
  ('erpd_office', 'erp.videos'),
  ('erpd_store', 'erp.alerts'), ('erpd_store', 'erp.rawMaterials'), ('erpd_store', 'erp.suppliers'), ('erpd_store', 'erp.godowns'),
  ('erpd_store', 'erp.requisitions'), ('erpd_store', 'erp.register'), ('erpd_store', 'erp.stock'), ('erpd_store', 'erp.rmLevels'),
  ('erpd_store', 'erp.transfers'), ('erpd_store', 'erp.expenses'), ('erpd_store', 'erp.videos'),
  ('erpd_tester', 'erp.testing'), ('erpd_tester', 'erp.expenses'), ('erpd_tester', 'erp.videos'),
  ('erpd_production', 'erp.alerts'), ('erpd_production', 'erp.stock'), ('erpd_production', 'erp.sfgBatches'), ('erpd_production', 'erp.fgFill'),
  ('erpd_production', 'erp.packBatches'), ('erpd_production', 'erp.transfers'), ('erpd_production', 'erp.fgLevels'),
  ('erpd_production', 'erp.expenses'), ('erpd_production', 'erp.videos'),
  ('erpd_godown', 'erp.alerts'), ('erpd_godown', 'erp.orders'), ('erpd_godown', 'erp.transfers'), ('erpd_godown', 'erp.stock'),
  ('erpd_godown', 'erp.expenses'), ('erpd_godown', 'erp.videos'),
  ('erpd_orderdesk', 'erp.orders'), ('erpd_orderdesk', 'erp.customers'), ('erpd_orderdesk', 'erp.priceLists'), ('erpd_orderdesk', 'erp.products'),
  ('erpd_orderdesk', 'erp.expenses'), ('erpd_orderdesk', 'erp.videos'),
  ('erpd_logistics', 'erp.alerts'), ('erpd_logistics', 'erp.transport'), ('erpd_logistics', 'erp.expenses'), ('erpd_logistics', 'erp.videos'),
  ('erpd_sales', 'erp.requests'), ('erpd_sales', 'erp.myCustomers'), ('erpd_sales', 'erp.expenses'), ('erpd_sales', 'erp.videos')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "erp_designation_powers" ("designation_id", "power") VALUES
  ('erpd_admin', 'viewPurchaseMoney'), ('erpd_admin', 'viewCost'), ('erpd_admin', 'viewSalesRate'), ('erpd_admin', 'viewSalesAmounts'),
  ('erpd_admin', 'reopenPurchase'), ('erpd_admin', 'lostStock'), ('erpd_admin', 'customerStatus'), ('erpd_admin', 'approveParty'),
  ('erpd_admin', 'decideRequests'), ('erpd_admin', 'employeeAdmin'),
  ('erpd_office', 'viewPurchaseMoney'), ('erpd_office', 'viewSalesRate'), ('erpd_office', 'viewSalesAmounts'), ('erpd_office', 'customerStatus'),
  ('erpd_orderdesk', 'viewSalesRate'),
  ('erpd_sales', 'viewSalesAmounts')
ON CONFLICT DO NOTHING;
