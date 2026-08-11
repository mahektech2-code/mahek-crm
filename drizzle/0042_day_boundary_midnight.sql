-- The working day flips at midnight, not at 5 am.
--
-- The 5 was a shipped default, not a decision anybody made: it meant a
-- dashboard read at 2 am still showed the previous day's figures, with nothing
-- on the screen saying why. Everybody here means midnight by "today", so that
-- is what the registry now defaults to.
--
-- A default living in the registry is not enough on its own: `seedConfig`
-- writes a row for every setting the first time it runs, so any deployment
-- that has been seeded is carrying a stored 5 that would win over the new
-- default forever.
--
-- What this must NOT do is overwrite somebody's decision. `updated_by_id` is
-- null on a row `seedConfig` wrote and carries an actor id on anything saved
-- from the Settings screen, so a stored value nobody has touched is exactly
-- what this matches — plus the value itself still being the old default. A
-- deployment that deliberately chose 5 has an actor against it and is left
-- alone.
UPDATE "app_settings"
   SET "value" = '0'::jsonb
 WHERE "key" = 'workingDay.dayBoundaryHour'
   AND "updated_by_id" IS NULL
   AND "value" = '5'::jsonb;
