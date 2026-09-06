-- Five-second GPS sampling, once somebody is checked in.
--
-- Fifteen was a shipped default, not a ceiling: at five seconds a trail hugs
-- the actual road on its own, and Live map's Snap-to-Road only has to close
-- the gaps that a lost signal leaves rather than the gaps sampling leaves. It
-- costs real battery over a full field day, which is exactly why it is still
-- configuration and not a constant — a team that finds it too hungry can
-- raise it back from the Settings screen.
--
-- A default in the registry is not enough on its own: `seedConfig` writes a
-- row for every setting the first time it runs, so a deployment that has
-- been seeded is carrying a stored 15 that would win over the new default
-- for ever.
--
-- What this must NOT do is overwrite somebody's decision. `updated_by_id` is
-- null on a row `seedConfig` wrote and carries an actor id on anything saved
-- from the Settings screen, so a stored value nobody has touched is exactly
-- what this matches — plus the value itself still being the old default. A
-- deployment that deliberately chose 15, or chose something else entirely,
-- is left alone.
UPDATE "app_settings"
   SET "value" = '5'::jsonb
 WHERE "key" = 'mbos.location.trackEverySeconds'
   AND "updated_by_id" IS NULL
   AND "value" = '15'::jsonb;
