-- A TERRITORY IS A HIERARCHY, and a row that does not say what it sits inside
-- cannot express one.
--
-- "Pune" as a bare city row is two different allocations depending on which
-- state somebody had in mind, and India has an Aurangabad in Maharashtra and
-- another in Bihar. `parent` is what the row was picked UNDER: a city's state,
-- a beat's city. Empty means not stated, which is what every row written before
-- this migration means and what a legacy row goes on meaning — the clause
-- reads an empty parent as "match this place wherever it is", exactly as it
-- did yesterday, so adding the column moves nobody's book.
--
-- Not nullable: '' collapses in a unique index where NULL does not, and the
-- key below has to stop one person being allocated the same place twice.
ALTER TABLE "mbos_user_territories"
  ADD COLUMN IF NOT EXISTS "parent" text NOT NULL DEFAULT '';

-- The key gains it, because Pune-in-Maharashtra and Pune-in-Bihar are two
-- allocations and the old three-column key would have refused the second.
DROP INDEX IF EXISTS "mbos_user_territories_key";
CREATE UNIQUE INDEX IF NOT EXISTS "mbos_user_territories_key"
  ON "mbos_user_territories" ("user_id", "kind", "region", "parent");
