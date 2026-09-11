-- WHO STARTED THIS DAY.
--
-- `mbos_journey_plans` was built for one direction: the office proposes a city
-- and the salesman answers. A day he starts himself is the same row reaching
-- the same states by a different door, and without a mark saying so the two are
-- indistinguishable afterwards — "he went where he was asked" and "he chose it
-- himself" read identically on every screen and in every report.
--
-- FALSE is the default and that is load-bearing: every row that already exists
-- was proposed by the office, so adding this moves nothing on any screen. It is
-- the same reasoning `day_state` shipped with.
ALTER TABLE "mbos_journey_plans"
  ADD COLUMN IF NOT EXISTS "self_planned" boolean DEFAULT false NOT NULL;
