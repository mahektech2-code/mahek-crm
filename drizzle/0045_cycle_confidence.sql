-- How predictable a customer's buying cycle is, 0–100.
--
-- Null until `recomputeBuyingCycle` next runs, and null forever for anybody
-- whose cycle is a default — a guess has no confidence to report, and a
-- number against one would be the guess wearing a measurement's clothes.
--
-- Derived, so it is never hand-edited: the nightly recompute writes it from
-- the same intervals the cycle itself is the median of.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "cycle_confidence" integer;
