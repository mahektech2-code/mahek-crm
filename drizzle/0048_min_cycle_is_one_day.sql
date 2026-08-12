-- A two-day buyer orders every two days.
--
-- `buyingCycle.minDays` shipped at 7, described as a clamp "against absurdly
-- short computed cycles". It was not that. Two orders on the same day are
-- already excluded before this floor is reached — they are one purchase split
-- across bills — so every interval that survives to be clamped is a real gap
-- between two real orders. What the 7 actually did was overwrite the truth
-- about the customers who order most often: somebody buying every two days was
-- recorded as buying every seven.
--
-- That is not only a wrong number on a screen. The cycle is what decides when
-- the Call Log rings them, and with the quiet window now capped at the cycle it
-- is what decides that too — so a real two-day cycle stored as seven is an
-- order chased five days late, every cycle, forever.
--
-- The floor stays at 1 rather than going away: `clamp` must not be able to
-- return 0, which would mean "due immediately" for the rest of time.
--
-- Same shape as 0042. A default in the registry is not enough on its own —
-- `seedConfig` writes a row for every setting the first time it runs, so a
-- seeded deployment carries a stored 7 that would win over the new default
-- forever. And it must not overwrite a decision: `updated_by_id` is null on a
-- row `seedConfig` wrote and carries an actor id on anything saved from the
-- Settings screen, so a deployment that deliberately chose 7 is left alone.
UPDATE "app_settings"
   SET "value" = '1'::jsonb
 WHERE "key" = 'buyingCycle.minDays'
   AND "updated_by_id" IS NULL
   AND "value" = '7'::jsonb;
--> statement-breakpoint
-- The stored cycles themselves are a CACHE, and this migration cannot rebuild
-- them: `recomputeAllBuyingCycles` reads order history through the ORM and is
-- not expressible here. Clearing the cached figure is not an option either —
-- the column is NOT NULL and drives the whole queue.
--
-- So they are left, and the nightly job rebuilds them on its next pass, which
-- is the same path every other derived value takes. `npm run jobs -- nightly`
-- brings it forward for anybody who does not want to wait for the small hours.
SELECT 1;
