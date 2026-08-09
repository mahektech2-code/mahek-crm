-- Raises the complaint attachment limit from five to six.
--
-- The registry default alone would not do it. `seedConfig` inserts only the
-- keys a database is MISSING, which is what stops a deploy overwriting numbers
-- a manager has chosen — so every database that already exists keeps the five
-- it was seeded with, and the new default reaches nothing but a fresh install.
-- A setting changed in the registry and nowhere else is a setting changed only
-- for developers.
--
-- Narrow on purpose: only rows still holding the old default move. A manager
-- who has since set their own number keeps it, and the description is refreshed
-- alongside so the console does not explain a five that is no longer there.
--
-- Safe to re-run: after this, nothing matches 5 any more.

update app_settings
   set value = '6'::jsonb,
       description = 'Photographs and documents supporting one complaint. Six covers a pallet photographed from every side.',
       updated_at = now()
 where key = 'attachments.maxPerComplaint'
   and value = '5'::jsonb;
