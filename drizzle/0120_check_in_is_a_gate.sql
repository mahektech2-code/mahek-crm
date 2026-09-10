-- A check-in is refused past the radius, and the way past it is written down.
--
-- The distance between a salesman and the shop's own pin has been measured
-- since MBOS shipped, and it raised a FLAG: the visit saved, unverified, with
-- the metres against it, and somebody read that hours later when they could no
-- longer tell. Mahek asked for the check-in itself to be refused. It now is —
-- on the handset, where he is standing, which is the only moment the answer is
-- worth anything.
--
-- `engines/geo.ts` carries the argument for why that reversal is safe. The
-- short of it is that it refuses only the case a reading can actually prove:
-- no fix, a fix too wide to trust, and a shop with no pin all go through, and
-- the last of them pins the shop from the fix that was taken.
--
-- These two columns are the way past a refusal. A salesman who is genuinely in
-- the shop that the book has in the wrong place types a sentence, the visit
-- lands unverified carrying it, and he may ask for the pin to be moved to
-- where he stood.
CREATE TYPE "mbos_pin_correction" AS ENUM ('requested', 'accepted', 'rejected');

ALTER TABLE "mbos_visits"
  ADD COLUMN "check_in_override_reason" text,
  ADD COLUMN "pin_correction" "mbos_pin_correction",
  ADD COLUMN "pin_correction_decided_at" timestamp with time zone,
  ADD COLUMN "pin_correction_decided_by_id" text;

-- Requests waiting on somebody. Partial, because on a year of visits this is
-- the handful that are still open and a manager's screen asks for exactly
-- them; every other row in the table has a null here and is not worth indexing.
CREATE INDEX IF NOT EXISTS "mbos_visits_pin_correction_idx"
  ON "mbos_visits" ("check_in_at" DESC)
  WHERE "pin_correction" = 'requested';

-- 200 metres was the distance a visit was FLAGGED at, which is a generous
-- number for a question somebody asks later and the wrong one for a refusal
-- made at a shop door. Mahek asked for 100.
--
-- The same shape as `0042_day_boundary_midnight`, and for the same reason:
-- `seedConfig` writes a row for every setting the first time it runs, so a
-- seeded deployment carries a stored 200 that would win over the new default
-- for ever. `updated_by_id IS NULL` is what tells a seeded row from a decision
-- — a team that chose 200 has an actor against it and is left exactly alone,
-- which for this setting matters more than most: it is now the number that
-- decides whether somebody can record his work at all.
UPDATE "app_settings"
   SET "value" = '100'::jsonb
 WHERE "key" = 'mbos.location.visitMismatchM'
   AND "updated_by_id" IS NULL
   AND "value" = '200'::jsonb;
