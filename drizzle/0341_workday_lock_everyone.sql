-- PUNCHING IN IS MANDATORY FOR EVERYBODY (Nov 2026).
--
-- Mahek asked that nobody who punches in can use any app on a working day
-- without punching in first — "literally no one". So the lock is switched on
-- and platform administrators are no longer exempt, whatever was stored
-- before: this is the owner's instruction, not a default moving. Either can
-- still be changed afterwards on HRMS → Attendance → Settings.
update app_settings
   set value = 'true'::jsonb
 where key = 'hrms.workday.lockEnabled';

update app_settings
   set value = 'false'::jsonb
 where key = 'hrms.workday.exemptPlatformAdmins';
