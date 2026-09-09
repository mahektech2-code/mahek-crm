-- A PERSON'S GEOGRAPHY, which is now two people's question rather than one.
--
-- `mbos_manager_territories` held the regions a manager oversees. A salesman
-- needs the same fact about himself — which cities he works — so that his book,
-- his map and his day's picking are bounded to where he actually goes.
--
-- One table, because it is one idea: which geography does this person work.
-- Two would be two places for "Vidarbha" to be spelled differently.
alter table if exists "mbos_manager_territories"
  rename to "mbos_user_territories";

-- WHAT KIND OF GEOGRAPHY, because a state and a city are not interchangeable
-- and the column they match against is different for each.
--
-- Defaults to `region`, so every row that existed keeps exactly the meaning it
-- had and `managerScope` — which now asks for `region` explicitly — reads the
-- same set it read before.
alter table "mbos_user_territories"
  add column if not exists "kind" text not null default 'region';

-- The uniqueness is per kind now: somebody can work the city of Nagpur AND the
-- region of Vidarbha, and those are different rows rather than a clash.
drop index if exists "mbos_manager_territories_key";
create unique index if not exists "mbos_user_territories_key"
  on "mbos_user_territories" ("user_id", "kind", "region");

-- The hot query: this person's territories, on every scoped read.
create index if not exists "mbos_user_territories_user_idx"
  on "mbos_user_territories" ("user_id", "kind");

-- NOTE FOR WHOEVER READS THIS NEXT.
--
-- A salesman's territory is a FILTER and not a permission. It narrows a book he
-- already had — `ASSIGNED_TO_SQL` and the two seats beside it are still the
-- whole of who may see what, and they are unchanged by this migration. Nobody
-- gains sight of another salesman's customer by being allocated a city.
--
-- That matters because the two look alike from a distance, and a later reader
-- who mistakes this for the security boundary might remove a real check
-- thinking it is redundant. It is not. It is a working view.
