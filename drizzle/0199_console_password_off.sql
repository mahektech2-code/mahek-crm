-- THE ADMIN CONSOLE NO LONGER ASKS FOR THE PASSWORD AGAIN, by default.
--
-- 0198 made the console ask for the password after `auth.console.confirmMinutes`
-- away from it, defaulting to 30. Mahek asked for switching from another app to
-- the console not to ask, so 0 now means never and is the default. The check
-- itself is kept, so turning it back on is a number on the Settings screen.
--
-- Only where nobody chose the old value: `updated_by_id is null` AND the stored
-- value is still the old default. A team that set its own window keeps it.
update app_settings
   set value = '0'::jsonb
 where key = 'auth.console.confirmMinutes'
   and updated_by_id is null
   and value = '30'::jsonb;
