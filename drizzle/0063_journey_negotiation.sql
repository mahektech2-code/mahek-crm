-- A journey plan is agreed, not issued.
--
-- From `MBOS Manager Console.dc.html`: "A day in a plan moves proposed →
-- refused → agreed → planned. Only the salesman picks the customers, because
-- he knows the city; the route is built from that."
--
-- That is a different thing from what was built. The manager used to pick the
-- shops and publish, which puts the person with the least local knowledge in
-- charge of the decision that needs the most: whether Tumakuru market is shut
-- on Wednesday, whether Surat and Rajkot back to back is 340 km in a day. Both
-- of those are real refusals from the design's own fixture, and neither is
-- something an office screen could have known.
--
-- So the manager proposes a CITY and the salesman answers. He can refuse with
-- a reason and name what he wants instead; once a day is agreed he picks the
-- shops, and only then is it planned.
--
-- `day_state` defaults to 'planned' so every plan that already exists keeps
-- exactly the meaning it had — they were made under the old model, where the
-- shops were already chosen. Nothing moves on the day this ships.
DO $$ BEGIN
  CREATE TYPE "public"."mbos_plan_day_state" AS ENUM ('proposed', 'refused', 'agreed', 'planned');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "mbos_journey_plans"
  ADD COLUMN IF NOT EXISTS "day_state" "mbos_plan_day_state" DEFAULT 'planned' NOT NULL,
  -- The unit the manager actually proposes. A beat is the salesman's own
  -- division of a city and he is the one who knows it; a city is what an
  -- office can sensibly decide.
  ADD COLUMN IF NOT EXISTS "city" text,
  ADD COLUMN IF NOT EXISTS "proposed_by_id" text,
  ADD COLUMN IF NOT EXISTS "proposed_at" timestamp with time zone,
  -- Why he will not walk it, in his words. Required by the action that writes
  -- it: a refusal a manager cannot act on is a day that stays unplanned while
  -- both of them wait for the other.
  ADD COLUMN IF NOT EXISTS "refusal_reason" text,
  -- What he wants instead. Optional — "not this" is a legitimate answer, and
  -- demanding an alternative turns a refusal into a negotiation he may not be
  -- ready to have.
  ADD COLUMN IF NOT EXISTS "counter_city" text,
  ADD COLUMN IF NOT EXISTS "responded_at" timestamp with time zone;

DO $$ BEGIN
  ALTER TABLE "mbos_journey_plans"
    ADD CONSTRAINT "mbos_journey_plans_proposed_by_id_users_id_fk"
    FOREIGN KEY ("proposed_by_id") REFERENCES "public"."users"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- The manager's own worklist: what has been refused, and what is still
-- unanswered. Both are somebody waiting on somebody.
CREATE INDEX IF NOT EXISTS "mbos_journey_plans_state_idx"
  ON "mbos_journey_plans" ("day_state", "plan_date");
