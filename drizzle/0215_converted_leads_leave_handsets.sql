-- A CONVERTED LEAD LEAVES EVERY HANDSET'S LEADS SCREENS, including the ones
-- that converted before anything said so.
--
-- The handset keeps a lead in two tables and asks "is this a lead" of its
-- `leads` table. The leads channel stops sending a lead once it is `won`, and a
-- pull only says what exists, so every lead converted until now is still on
-- the phones that held it -- listed under Leads at its last rung, opening the
-- funnel for a shop the office already bills. `recordConversion` now writes a
-- `leads` tombstone as it converts; this writes the one each earlier
-- conversion owed. The handset ARCHIVES a tombstoned lead rather than deleting
-- it, and the customer row is untouched, so the shop stays in his book.
--
-- `user_id` null: everybody, and a phone that never held the lead archives
-- nothing. Guarded on an existing tombstone so a re-run adds none. The stage
-- is compared as text: a literal of a migration-era enum value is what fails a
-- from-scratch build.
insert into mbos_deletions (id, entity, entity_id, user_id, reason)
select
  'del_' || left(replace(gen_random_uuid()::text, '-', ''), 12),
  'leads',
  c.id,
  null,
  'lead_converted'
from customers c
where c.lead_stage::text = 'won'
  and not exists (
    select 1
      from mbos_deletions d
     where d.entity = 'leads'
       and d.entity_id = c.id
       and d.reason = 'lead_converted'
  );
