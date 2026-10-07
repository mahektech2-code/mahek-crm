-- THE PRODUCTION DEPARTMENTS. Purchase runs department by department:
-- Mixing & Blending asks for chemicals, tests them on arrival and makes SFG;
-- Refilling asks for cans and fills FG; Packing asks for empty boxes and
-- packing stationery and makes packing batches; the Production Head does all
-- of it. A department is held through the ERP designation.
ALTER TABLE "erp_designations" ADD COLUMN IF NOT EXISTS "department" text;
--> statement-breakpoint
ALTER TABLE "erp_designations" DROP CONSTRAINT IF EXISTS "erp_designations_department_check";
--> statement-breakpoint
ALTER TABLE "erp_designations" ADD CONSTRAINT "erp_designations_department_check" CHECK ("department" is null or "department" in ('mixing', 'refilling', 'packing', 'head'));
--> statement-breakpoint
-- The requirement's department list names the three. Packing was already on it.
INSERT INTO "erp_ref_values" ("id", "list_key", "value", "sort_order") VALUES
  ('erprv_dept_mixing', 'department', 'Mixing & Blending', 0),
  ('erprv_dept_refilling', 'department', 'Refilling', 0)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "erp_designations" ("id", "name", "description", "level", "all_screens", "department", "sort_order") VALUES
  ('erpd_mixing', 'Mixing & Blending', 'Raises chemical requirements, tests every chemical lot as it arrives and makes SFG batches.', 'associate', false, 'mixing', 61),
  ('erpd_refilling', 'Refilling', 'Raises can and drum requirements and fills SFG into cans and drums.', 'associate', false, 'refilling', 62),
  ('erpd_packing', 'Packing', 'Raises empty-box and packing-stationery requirements and makes packing batches.', 'associate', false, 'packing', 63),
  ('erpd_prodhead', 'Production Head', 'Every step of Mixing & Blending, Refilling and Packing: their requirements, chemical testing, SFG, filling and packing.', 'manager', false, 'head', 64)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "erp_designation_modules" ("designation_id", "module") VALUES
  ('erpd_mixing', 'erp.departments'), ('erpd_mixing', 'erp.alerts'), ('erpd_mixing', 'erp.requisitions'), ('erpd_mixing', 'erp.testing'),
  ('erpd_mixing', 'erp.sfgBatches'), ('erpd_mixing', 'erp.recipes'), ('erpd_mixing', 'erp.stock'), ('erpd_mixing', 'erp.rmLevels'),
  ('erpd_mixing', 'erp.expenses'), ('erpd_mixing', 'erp.videos'),
  ('erpd_refilling', 'erp.departments'), ('erpd_refilling', 'erp.alerts'), ('erpd_refilling', 'erp.requisitions'), ('erpd_refilling', 'erp.fgFill'),
  ('erpd_refilling', 'erp.stock'), ('erpd_refilling', 'erp.rmLevels'), ('erpd_refilling', 'erp.fgLevels'),
  ('erpd_refilling', 'erp.expenses'), ('erpd_refilling', 'erp.videos'),
  ('erpd_packing', 'erp.departments'), ('erpd_packing', 'erp.alerts'), ('erpd_packing', 'erp.requisitions'), ('erpd_packing', 'erp.packBatches'),
  ('erpd_packing', 'erp.stock'), ('erpd_packing', 'erp.rmLevels'), ('erpd_packing', 'erp.fgLevels'),
  ('erpd_packing', 'erp.expenses'), ('erpd_packing', 'erp.videos'),
  ('erpd_prodhead', 'erp.departments'), ('erpd_prodhead', 'erp.alerts'), ('erpd_prodhead', 'erp.requisitions'), ('erpd_prodhead', 'erp.purchaseOrders'),
  ('erpd_prodhead', 'erp.testing'), ('erpd_prodhead', 'erp.sfgBatches'), ('erpd_prodhead', 'erp.fgFill'), ('erpd_prodhead', 'erp.packBatches'),
  ('erpd_prodhead', 'erp.recipes'), ('erpd_prodhead', 'erp.stock'), ('erpd_prodhead', 'erp.rmLevels'), ('erpd_prodhead', 'erp.fgLevels'),
  ('erpd_prodhead', 'erp.transfers'), ('erpd_prodhead', 'erp.expenses'), ('erpd_prodhead', 'erp.videos')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- The new Departments screen reaches everybody who already works a
-- production step. A whole-ERP grant reaches it on its own; a NARROWED one
-- holding SFG, filling or packing gains it, and so do the designations built
-- on those screens — so nobody holding one becomes "customised".
-- (The app is copied from the person's own row: see 0222 on enum literals.)
INSERT INTO "app_module_access" ("id", "user_id", "app", "module")
SELECT DISTINCT ON (m.user_id) 'amg_' || substr(md5(m.user_id || 'erp.departments'), 1, 20), m.user_id, m.app, 'erp.departments'
  FROM "app_module_access" m
 WHERE m.app::text = 'erp' AND m.module in ('erp.sfgBatches', 'erp.fgFill', 'erp.packBatches')
   AND NOT EXISTS (SELECT 1 FROM "app_module_access" x WHERE x.user_id = m.user_id AND x.module = 'erp.departments');
--> statement-breakpoint
INSERT INTO "erp_designation_modules" ("designation_id", "module")
SELECT DISTINCT d.designation_id, 'erp.departments' FROM "erp_designation_modules" d WHERE d.module in ('erp.sfgBatches', 'erp.fgFill', 'erp.packBatches')
ON CONFLICT DO NOTHING;
