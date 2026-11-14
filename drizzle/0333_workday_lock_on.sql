-- THE WORKDAY LOCK IS ON, by default.
--
-- 0332 shipped `hrms.workday.lockEnabled` off so nobody was locked on deploy
-- day. Mahek asked for it on. The default moved to true in the registry, which
-- is what a deployment with no stored row reads; this moves a stored row too,
-- but only where nobody chose it (`updated_by_id is null`) and it still holds
-- the old default. Somebody who switched it off on the Settings screen keeps
-- it off.
update app_settings
   set value = 'true'::jsonb
 where key = 'hrms.workday.lockEnabled'
   and updated_by_id is null
   and value = 'false'::jsonb;
