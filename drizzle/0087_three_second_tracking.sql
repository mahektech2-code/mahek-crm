-- Three-second GPS sampling, once somebody is checked in.
--
-- Five was itself only a week old (0086) before the same reasoning asked for
-- tighter again: the closer the interval gets to continuous, the less of the
-- Live map's trail has to fall back on a guess between two distant fixes.
-- Three is close enough to exact that the remaining gaps are almost entirely
-- ones no interval could have closed — a dropped signal, a backgrounded app —
-- which is what the trail's own gap line now draws honestly rather than
-- papering over.
--
-- A default in the registry is not enough on its own: `seedConfig` writes a
-- row for every setting the first time it runs, so a deployment that has
-- been seeded is carrying a stored 5 that would win over the new default
-- for ever.
--
-- What this must NOT do is overwrite somebody's decision. `updated_by_id` is
-- null on a row `seedConfig` wrote and carries an actor id on anything saved
-- from the Settings screen, so a stored value nobody has touched is exactly
-- what this matches — plus the value itself still being the previous
-- default. A deployment that deliberately chose 5, or chose something else
-- entirely, is left alone.
UPDATE "app_settings"
   SET "value" = '3'::jsonb
 WHERE "key" = 'mbos.location.trackEverySeconds'
   AND "updated_by_id" IS NULL
   AND "value" = '5'::jsonb;
