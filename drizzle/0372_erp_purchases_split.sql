-- PURCHASES IS THREE PAGES NOW: Goods in (erp.inward), Bills (erp.register,
-- the key the register always had) and Drum labels (erp.barcode). They were
-- the three tabs of one Purchases page; the owner's purchase menu numbers the
-- flow 1 Requirements … 5 Bills with Drum labels under Tools, so each is its
-- own sidebar row, its own grant and its own Access · Edit · Delete.
--
-- NOBODY GAINS OR LOSES A THING. For every place a grant is stored:
--   * a page row erp.register with NO tab rows held every tab, so it gains
--     erp.inward and erp.barcode with the SAME ticks;
--   * a page narrowed to some tabs (rows erp.register.<tab>) gets exactly the
--     pages for the tabs it held, with the page's ticks, and loses
--     erp.register only where its Register tab was not held;
--   * the old tab rows go, since the page they narrowed has no tabs.
-- An account with no ERP rows at all holds every screen and is not touched.
-- Designations carry erp.register the same way.
--
-- The app is copied from the row rather than written as the literal 'erp'
-- (see 0182): an enum value may not be used in the transaction that added it.
-- Safe to re-run: inserts skip existing rows, deletes find nothing twice.

-- 1. The older per-module table (what the sidebar and the route guard read).
INSERT INTO "app_module_access" ("id", "user_id", "app", "module", "granted_by_id")
SELECT 'mod_' || substr(md5(m."user_id" || '|' || k."to"), 1, 16), m."user_id", m."app", k."to", m."granted_by_id"
  FROM "app_module_access" m
 CROSS JOIN (VALUES ('erp.inward', 'erp.register.inward'), ('erp.barcode', 'erp.register.barcode')) AS k("to", "tab")
 WHERE m."app"::text = 'erp' AND m."module" = 'erp.register'
   AND (NOT EXISTS (SELECT 1 FROM "app_screen_access" t WHERE t."user_id" = m."user_id" AND t."screen" LIKE 'erp.register.%')
        OR EXISTS (SELECT 1 FROM "app_screen_access" t WHERE t."user_id" = m."user_id" AND t."screen" = k."tab"))
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "app_module_access" m
 WHERE m."app"::text = 'erp' AND m."module" = 'erp.register'
   AND EXISTS (SELECT 1 FROM "app_screen_access" t WHERE t."user_id" = m."user_id" AND t."screen" LIKE 'erp.register.%')
   AND NOT EXISTS (SELECT 1 FROM "app_screen_access" t WHERE t."user_id" = m."user_id" AND t."screen" = 'erp.register.register');
--> statement-breakpoint
-- 2. The screen model's rows (Access · Edit · Delete per page).
INSERT INTO "app_screen_access" ("id", "user_id", "app", "screen", "can_edit", "can_delete", "edit_by_delete", "granted_by_id")
SELECT 'scr_' || substr(md5(p."user_id" || '|' || k."to"), 1, 16), p."user_id", p."app", k."to", p."can_edit", p."can_delete", p."edit_by_delete", p."granted_by_id"
  FROM "app_screen_access" p
 CROSS JOIN (VALUES ('erp.inward', 'erp.register.inward'), ('erp.barcode', 'erp.register.barcode')) AS k("to", "tab")
 WHERE p."screen" = 'erp.register'
   AND (NOT EXISTS (SELECT 1 FROM "app_screen_access" t WHERE t."user_id" = p."user_id" AND t."screen" LIKE 'erp.register.%')
        OR EXISTS (SELECT 1 FROM "app_screen_access" t WHERE t."user_id" = p."user_id" AND t."screen" = k."tab"))
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "app_screen_access" p
 WHERE p."screen" = 'erp.register'
   AND EXISTS (SELECT 1 FROM "app_screen_access" t WHERE t."user_id" = p."user_id" AND t."screen" LIKE 'erp.register.%')
   AND NOT EXISTS (SELECT 1 FROM "app_screen_access" t WHERE t."user_id" = p."user_id" AND t."screen" = 'erp.register.register');
--> statement-breakpoint
DELETE FROM "app_screen_access" WHERE "screen" LIKE 'erp.register.%';
--> statement-breakpoint
-- 3. Designations (page-level only, never narrowed to tabs).
INSERT INTO "erp_designation_modules" ("designation_id", "module")
SELECT d."designation_id", k."to"
  FROM "erp_designation_modules" d
 CROSS JOIN (VALUES ('erp.inward'), ('erp.barcode')) AS k("to")
 WHERE d."module" = 'erp.register'
ON CONFLICT DO NOTHING;
