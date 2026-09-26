-- THE CALLING DESK IS GRANTED, NOT INHERITED.
--
-- `crm.lead-calling-desk` is a new module of the CRM. An app grant with NO
-- module rows means every module, so without this every account that holds the
-- whole CRM would open the desk on the day this deploys -- which is every CRM
-- user, and the desk belongs to the telecaller and the administrator.
--
-- So each account that holds the CRM as "the whole app" is given the modules it
-- had, EXPLICITLY, minus the desk. What they can open does not change by one
-- screen; only what a future module would reach them by default does. The desk
-- is then granted the way every deliberate grant is: on the Access screen.
--
-- Left alone on purpose:
--   * a CRM administrator (the grant's own hat, or the account's when the grant
--     names none). An administrator holds everything everywhere and is who
--     decides who gets the desk; narrowing them here would take it from the
--     person who has to hand it out. Their "whole app" still includes it.
--   * anybody who already has module rows for the CRM: they were narrowed on
--     purpose, and the desk is simply not among what they were given.
--
-- The list below is the CRM's module registry (lib/modules.ts) as it stands in
-- this migration, minus the desk itself. It is a snapshot ON PURPOSE: a module
-- added later must reach the whole-app holders this does not touch, and must not
-- be granted retroactively by a migration that re-reads the registry.
--
-- Safe to re-run: the rows are skipped where they exist (the unique index on
-- user + module) and an account this has already narrowed has module rows, so
-- it is no longer "the whole app".

INSERT INTO "app_module_access" ("id", "user_id", "app", "module")
SELECT 'mod_' || substr(md5(aa."user_id" || '|' || k."module"), 1, 16),
       aa."user_id",
       'crm',
       k."module"
  FROM "app_access" aa
  JOIN "users" u ON u."id" = aa."user_id"
 CROSS JOIN (VALUES
   ('crm.dashboard'), ('crm.call-log'), ('crm.reminders'), ('crm.history'),
   ('crm.whatsapp'), ('crm.payments'), ('crm.outstanding'), ('crm.bills'),
   ('crm.customers'), ('crm.complaints'), ('crm.price-lists'),
   ('crm.deactivations'), ('crm.leads'), ('crm.lead-funnel'),
   ('crm.lead-intake'), ('crm.lead-qualify'), ('crm.samples'),
   ('crm.lead-commercial'), ('crm.lead-appointments'), ('crm.lead-actions'),
   ('crm.lead-handovers'), ('crm.lead-oversight'), ('crm.targets'),
   ('crm.performance'), ('crm.eod'), ('crm.help'), ('crm.settings')
 ) AS k("module")
 WHERE aa."app" = 'crm'
   AND COALESCE(aa."role"::text, u."role"::text) <> 'admin'
   AND NOT EXISTS (
     SELECT 1 FROM "app_module_access" m
      WHERE m."user_id" = aa."user_id" AND m."app" = 'crm'
   )
ON CONFLICT DO NOTHING;
