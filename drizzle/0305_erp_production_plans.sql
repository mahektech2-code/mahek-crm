-- UNDER PROCESS — the Production Head's daily production plan (PRD "Under
-- Process Tab"). One plan per day; its lines are the day's SFG manufacturing,
-- loose-can preparation and packing; every print is kept, because the next
-- print underlines what is new or edited since it. Nothing here moves stock.
CREATE TABLE IF NOT EXISTS "erp_production_plans" (
  "id" text PRIMARY KEY,
  "plan_no" integer NOT NULL,
  "plan_date" date NOT NULL,
  "godown_id" text REFERENCES "erp_godowns"("id") ON DELETE set null,
  "created_by_id" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by_id" text REFERENCES "users"("id") ON DELETE set null,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_production_plans_no_key" ON "erp_production_plans" ("plan_no");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_production_plans_date_key" ON "erp_production_plans" ("plan_date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_production_plan_lines" (
  "id" text PRIMARY KEY,
  "plan_id" text NOT NULL REFERENCES "erp_production_plans"("id") ON DELETE cascade,
  "category" text NOT NULL CHECK ("category" in ('sfg', 'loose', 'packing')),
  "item_id" text,
  "product_name" text NOT NULL,
  "product_code" text,
  "size" text,
  "quantity" double precision NOT NULL CHECK ("quantity" > 0),
  "unit" text NOT NULL,
  "remarks" text,
  "sort" integer NOT NULL DEFAULT 0,
  "created_by_id" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by_id" text REFERENCES "users"("id") ON DELETE set null,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  "deleted_by_id" text REFERENCES "users"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_production_plan_lines_plan_idx" ON "erp_production_plan_lines" ("plan_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_production_plan_prints" (
  "id" text PRIMARY KEY,
  "plan_id" text NOT NULL REFERENCES "erp_production_plans"("id") ON DELETE cascade,
  "print_no" integer NOT NULL,
  "printed_by_id" text REFERENCES "users"("id") ON DELETE set null,
  "printed_at" timestamptz NOT NULL DEFAULT now(),
  "lines" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_production_plan_prints_no_key" ON "erp_production_plan_prints" ("plan_id", "print_no");
--> statement-breakpoint
INSERT INTO "erp_series" ("key", "last") VALUES ('plan', 0) ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- The Production Head's job carries the new screen, and so does everybody who
-- holds that designation on a narrowed grant — so nobody holding it becomes
-- "customised". (The app is copied from the person's own row: see 0222.)
INSERT INTO "erp_designation_modules" ("designation_id", "module") VALUES ('erpd_prodhead', 'erp.underProcess') ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "app_module_access" ("id", "user_id", "app", "module")
SELECT DISTINCT ON (m.user_id) 'amg_' || substr(md5(m.user_id || 'erp.underProcess'), 1, 20), m.user_id, m.app, 'erp.underProcess'
  FROM "app_module_access" m
  JOIN "erp_user_designations" d ON d."user_id" = m."user_id" AND d."designation_id" = 'erpd_prodhead'
 WHERE m.app::text = 'erp'
   AND NOT EXISTS (SELECT 1 FROM "app_module_access" x WHERE x.user_id = m.user_id AND x.module = 'erp.underProcess');
