-- The HRMS simplified to three roles (Nov 2026): Tasks, My tasks and the Sales
-- desk were taken out. A narrowed grant's rows naming them would point at
-- screens that no longer exist; they are removed so the Access screen shows
-- what a person can actually open. No data behind those screens is touched.
DELETE FROM "app_module_access" WHERE "module" IN ('hrms.checklist', 'hrms.customers', 'hrms.myTasks');
