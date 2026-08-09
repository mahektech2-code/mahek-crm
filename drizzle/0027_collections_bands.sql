-- The collections ladder moves to 0–15, 16–29, 30+.
--
-- Three settings say it between them: stage 1 opens the band (0, not 7 — the
-- engine has always put everything below stage 2 in stage 1, so the seven
-- described a band that did not exist), stage 2 stays on day 16 where the
-- quiet window leaves it, and stage 3 comes forward from 45 to 30. The aging
-- buckets follow, because two screens disagreeing about how overdue the same
-- account is is exactly what `checkConsistency` exists to prevent.
--
-- Boundaries are EXCLUSIVE: 15 opens a band on day 16, 29 opens one on day 30.
--
-- The registry default alone would not do it. `seedConfig` inserts only the
-- keys a database is MISSING, which is what stops a deploy overwriting numbers
-- a manager has chosen — so an existing database keeps whatever it was seeded
-- with and a new default reaches nobody but a fresh install.
--
-- Narrow on purpose: only rows still holding the old default move. A manager
-- who has already set their own threshold keeps it. Safe to re-run — after
-- this, nothing matches the old values any more.
--
-- Follow-up stages are a derived cache keyed on these thresholds, so run
-- `npm run jobs -- nightly` (or `recomputeAllFollowUpStates`) afterwards; every
-- account between 30 and 44 days overdue becomes urgent, and until the rebuild
-- the stored stage still says otherwise.

update app_settings
   set value = '0'::jsonb,
       description = 'Days overdue at which the gentle WhatsApp nudge begins. Zero, because it begins the day the bill falls due: the reminder interval decides when the first message actually goes, and stage 1 is everything below stage 2 regardless.',
       updated_at = now()
 where key = 'escalation.stage1Days'
   and value = '7'::jsonb;

update app_settings
   set value = '30'::jsonb,
       updated_at = now()
 where key = 'escalation.stage3Days'
   and value = '45'::jsonb;

update app_settings
   set value = '[0, 15, 29]'::jsonb,
       description = 'Lower bounds in days overdue, EXCLUSIVE: a boundary of 15 opens a band on day 16. MUST align with the escalation thresholds, or the bills screen and the follow-up screen will disagree about how overdue an account is. The defaults trace the follow-up policy: the quiet window, then calling, then urgent.',
       updated_at = now()
 where key = 'bills.agingBuckets'
   and value = '[0, 15, 45, 90]'::jsonb;
