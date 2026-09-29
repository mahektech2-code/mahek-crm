-- The ERP's lists that Mahek Plus drew as separate screens are tabs of one
-- screen now: the four stock stages and their logs are Stock, the re-order
-- lists are tabs of the two levels screens, Pending LR / Track LR / Paid
-- freight are tabs of Transport, and the petty-cash credits are a tab of Petty
-- cash. A tab is not a module, so a grant that named one of the old screens
-- has to name the screen it now lives on, or somebody narrowed to "Pending LR"
-- would open the ERP on deploy day and find it gone.
--
-- Anybody holding ANY of a merged screen's old keys is given the merged one.
-- An account with no ERP module rows holds every screen already and is not
-- touched: adding rows would narrow it.
--
-- ERP powers moved to the Admin Console's access dialog and the ERP's own
-- Employees screen (a read-only copy of HRMS) is gone; their module rows name
-- nothing and are removed.
--
-- The app is copied from the row rather than written as the literal 'erp':
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
    ('erp.rmStock', 'erp.stock'), ('erp.rmLog', 'erp.stock'),
    ('erp.sfgStock', 'erp.stock'), ('erp.sfgLog', 'erp.stock'),
    ('erp.fgStock', 'erp.stock'), ('erp.fgLog', 'erp.stock'),
    ('erp.packStock', 'erp.stock'), ('erp.packLog', 'erp.stock'),
    ('erp.reorderRm', 'erp.rmLevels'), ('erp.reorderFg', 'erp.fgLevels'),
    ('erp.pendingLr', 'erp.transport'), ('erp.trackLr', 'erp.transport'),
    ('erp.paidFreight', 'erp.transport'),
    ('erp.credits', 'erp.expenses')
  ) AS k("from", "to") ON k."from" = m."module"
 WHERE m."app"::text = 'erp'
 ORDER BY m."user_id", k."to"
ON CONFLICT DO NOTHING;

-- No ERP module rows means EVERY ERP screen. Somebody narrowed to nothing but
-- the retired Powers or Employees screen would be widened to the whole app by
-- the delete below, so every narrowed account keeps a row for the dashboard,
-- which it holds in any case.
INSERT INTO "app_module_access" ("id", "user_id", "app", "module", "granted_by_id")
SELECT DISTINCT ON (m."user_id")
       'mod_' || substr(md5(m."user_id" || '|erp.dashboard'), 1, 16),
       m."user_id",
       m."app",
       'erp.dashboard',
       m."granted_by_id"
  FROM "app_module_access" m
 WHERE m."app"::text = 'erp'
 ORDER BY m."user_id"
ON CONFLICT DO NOTHING;

DELETE FROM "app_module_access"
 WHERE "app"::text = 'erp'
   AND "module" IN (
     'erp.rmStock', 'erp.rmLog', 'erp.sfgStock', 'erp.sfgLog',
     'erp.fgStock', 'erp.fgLog', 'erp.packStock', 'erp.packLog',
     'erp.reorderRm', 'erp.reorderFg',
     'erp.pendingLr', 'erp.trackLr', 'erp.paidFreight',
     'erp.credits', 'erp.powers', 'erp.employees'
   );
