-- The HRMS's 41 screens are 14 now (src/lib/hrms/registry.ts): each list the
-- first build drew as a screen of its own — leave approvals, the leave
-- calendar, pending check-outs, advances, to-dos and the rest — is a TAB of
-- the screen it belongs to. A tab is not a module, so a grant that named one
-- of the old screens has to name the screen it now lives on, or somebody
-- narrowed to "Leave approvals" would open HRMS on deploy day and find it gone.
--
-- Anybody holding ANY of a merged screen's old keys is given the merged one.
-- An account with no HRMS module rows holds every screen already and is not
-- touched: adding rows would narrow it.
--
-- The app is copied from the row rather than written as the literal 'hrms':
-- on a database built from nothing every migration runs in one transaction,
-- and an enum value may not be used in the transaction that added it.
--
-- Safe to re-run: the insert skips rows that exist, and the delete finds
-- nothing the second time.

INSERT INTO "app_module_access" ("id", "user_id", "app", "module", "granted_by_id")
SELECT DISTINCT ON (m."user_id", k."to")
       'mod_' || substr(md5(m."user_id" || '|' || k."to"), 1, 16),
       m."user_id",
       m."app",
       k."to",
       m."granted_by_id"
  FROM "app_module_access" m
  JOIN (VALUES
    ('hrms.pendingOut', 'hrms.attendance'), ('hrms.absentees', 'hrms.attendance'),
    ('hrms.attChart', 'hrms.attendance'), ('hrms.monthly', 'hrms.attendance'),
    ('hrms.overtime', 'hrms.attendance'),
    ('hrms.approvals', 'hrms.leave'), ('hrms.leaveCal', 'hrms.leave'),
    ('hrms.holidays', 'hrms.leave'), ('hrms.leaveSetup', 'hrms.leave'),
    ('hrms.advances', 'hrms.payroll'), ('hrms.expenses', 'hrms.payroll'),
    ('hrms.todos', 'hrms.checklist'), ('hrms.buddy', 'hrms.checklist'),
    ('hrms.templates', 'hrms.checklist'),
    ('hrms.salesPerf', 'hrms.kpi'), ('hrms.staffPerf', 'hrms.kpi'),
    ('hrms.eom', 'hrms.kpi'), ('hrms.points', 'hrms.kpi'),
    ('hrms.calling', 'hrms.customers'), ('hrms.activity', 'hrms.customers'),
    ('hrms.journey', 'hrms.customers'),
    ('hrms.idCards', 'hrms.employees'), ('hrms.timings', 'hrms.employees'),
    ('hrms.assignments', 'hrms.assetStock'),
    ('hrms.grievances', 'hrms.help'),
    ('hrms.refLists', 'hrms.settings')
  ) AS k("from", "to") ON k."from" = m."module"
 WHERE m."app"::text = 'hrms'
 ORDER BY m."user_id", k."to"
ON CONFLICT DO NOTHING;

-- No HRMS module rows means EVERY HRMS screen. Somebody narrowed to nothing
-- but retired screens would be widened to the whole app by the delete below,
-- so every narrowed account keeps a row for check-in, which it holds anyway.
INSERT INTO "app_module_access" ("id", "user_id", "app", "module", "granted_by_id")
SELECT DISTINCT ON (m."user_id")
       'mod_' || substr(md5(m."user_id" || '|hrms.home'), 1, 16),
       m."user_id",
       m."app",
       'hrms.home',
       m."granted_by_id"
  FROM "app_module_access" m
 WHERE m."app"::text = 'hrms'
 ORDER BY m."user_id"
ON CONFLICT DO NOTHING;

DELETE FROM "app_module_access"
 WHERE "app"::text = 'hrms'
   AND "module" IN (
     'hrms.pendingOut', 'hrms.absentees', 'hrms.attChart', 'hrms.monthly', 'hrms.overtime',
     'hrms.approvals', 'hrms.leaveCal', 'hrms.holidays', 'hrms.leaveSetup',
     'hrms.advances', 'hrms.expenses',
     'hrms.todos', 'hrms.buddy', 'hrms.templates',
     'hrms.salesPerf', 'hrms.staffPerf', 'hrms.eom', 'hrms.points',
     'hrms.calling', 'hrms.activity', 'hrms.journey',
     'hrms.idCards', 'hrms.timings',
     'hrms.assignments',
     'hrms.grievances',
     'hrms.refLists'
   );
