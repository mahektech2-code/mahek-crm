-- Visits is a tab of Journeys & visits now (src/lib/modules.ts): the plan and
-- the visits it produced are one story — allocated against visited — and two
-- screens made the manager hold one half in his head while reading the other.
-- A tab is not a module, so a grant that named `sales.visits` has to name the
-- screen it now lives on, or somebody narrowed to Visits would open the Sales
-- Dashboard on deploy day and find it gone.
--
-- An account with no Sales module rows holds every screen already and is not
-- touched: adding rows would narrow it. The app is copied from the row rather
-- than written as a literal, as 0201 explains.
--
-- Safe to re-run: the insert skips rows that exist, and the delete finds
-- nothing the second time.

INSERT INTO "app_module_access" ("id", "user_id", "app", "module", "granted_by_id")
SELECT DISTINCT ON (m."user_id")
       'mod_' || substr(md5(m."user_id" || '|sales.journeys'), 1, 16),
       m."user_id",
       m."app",
       'sales.journeys',
       m."granted_by_id"
  FROM "app_module_access" m
 WHERE m."module" = 'sales.visits'
 ORDER BY m."user_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "app_module_access" WHERE "module" = 'sales.visits';
