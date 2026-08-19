-- `0055` added every missing weight and did NOT remove the stale one.
--
-- It ended `|| jsonb_build_object(...) - 'orderDueSoon'`, and `-` binds tighter
-- than `||` — so it parsed as `value || (built - 'orderDueSoon')`, stripping
-- the key from the object being merged IN, where it had never been, and leaving
-- the one in the stored value untouched. It reported success because it did
-- succeed; it just did not do the half nobody could see.
--
-- Harmless in itself: nothing reads `orderDueSoon`. The code renamed it to
-- `routineCall` long ago, and `0055` set that correctly. What it leaves is a
-- key on the Settings screen that looks like a live setting and moves nothing,
-- which is the sort of thing somebody eventually tunes and then wonders about.
update app_settings
   set value = value - 'orderDueSoon'
 where key = 'queue.tierWeights'
   and updated_by_id is null;
