-- A dictated call note is as long as the call was.
--
-- `interactions.maxNotesLength` shipped at 2,000 characters, which was a typed
-- note's ceiling. A telecaller speaking about a call for two minutes passes it,
-- and the save refused the whole call over the length of its note — the
-- assistant had read every word, and the form would not keep them. The
-- recorder now has no practical ceiling, so the note must not have one either.
--
-- Only where nobody chose the old value: `updated_by_id is null` AND the stored
-- value is still the old default. A team that set its own limit keeps it.
update app_settings
   set value = '20000'::jsonb
 where key = 'interactions.maxNotesLength'
   and updated_by_id is null
   and value = '2000'::jsonb;
