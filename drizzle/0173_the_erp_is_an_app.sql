-- The ERP becomes an app of its own, granted like every other — a row in
-- `app_access`, with its screens narrowed by module.
--
-- On its own, ahead of anything that could use it: a value added to an enum
-- cannot be USED in the transaction that adds it, and drizzle-kit applies
-- every pending migration in one transaction. The app is granted with
-- `npm run app:grant -- erp <email>`, never by a migration.
alter type "public"."app_id" add value 'erp';
