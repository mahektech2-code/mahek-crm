-- ADMIN ON AN APP IS ADMIN OF THAT APP, and only Admin on the Admin Console is
-- a platform administrator.
--
-- Until now `can()` answered yes to everything for any hat whose level was
-- `admin`, whatever app it was worn in, and `users.role` copied the widest
-- level onto the account. So "HRMS admin" approved orders, confirmed payments,
-- read every salary and could sign in as anybody. The code now reads an admin
-- hat against its own app; this migration makes the stored rows say the same.
--
-- 1. A grant with no level meant "the account's own", which is the widest
--    level held anywhere — so a CRM grant made from a terminal turned into a
--    CRM manager the day its holder became a manager of anything else. Every
--    such row is given the level it was resolving to TODAY, so nobody's
--    reach moves on deploy; from here a missing level reads as associate.
UPDATE app_access a
   SET role = u.role
  FROM users u
 WHERE a.user_id = u.id
   AND a.role IS NULL;
--> statement-breakpoint
-- 2. Whoever is a platform administrator today AND holds the Admin Console
--    keeps being one: their console grant is set to `admin` explicitly. This is
--    what stops the deploy locking every administrator out of the console.
UPDATE app_access a
   SET role = 'admin'
  FROM users u
 WHERE a.user_id = u.id
   AND a.app = 'admin'
   AND u.role = 'admin';
--> statement-breakpoint
-- 3. `users.role` is re-derived under the new meaning: `admin` only for a
--    platform administrator, `manager` for anybody who runs or administers any
--    app, `associate` otherwise. Twenty-odd checks read `user.role = 'admin'`
--    as "may do anything"; after this they mean exactly that.
UPDATE users u
   SET role = CASE
     WHEN EXISTS (SELECT 1 FROM app_access a
                   WHERE a.user_id = u.id AND a.app = 'admin' AND a.role = 'admin')
       THEN 'admin'::role
     WHEN EXISTS (SELECT 1 FROM app_access a
                   WHERE a.user_id = u.id AND a.app <> 'people'
                     AND a.role IN ('manager', 'admin'))
       THEN 'manager'::role
     ELSE 'associate'::role
   END;
