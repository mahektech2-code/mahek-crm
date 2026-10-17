-- WHICH LIQUIDS A MIX TARGET MAY BE AIMED AT, which nobody could choose.
--
-- A mix band is set on a formulation and `mixCategories()` offers every ACTIVE
-- one, alphabetically. That conflates two different questions. `active` says
-- whether a liquid is in the catalogue at all — retire it and its SKUs stop
-- being offered on orders — and there is no way to say the other thing: that a
-- liquid is very much on sale and is not something to aim a salesman's month at.
-- On this book that is most of the nineteen, so the manager setting a target
-- picks three out of a long alphabetical list every month with nothing marking
-- the three that matter.
--
-- `offer_for_mix` is that second question. DEFAULT TRUE, so the day this lands
-- every screen offers exactly what it offered before and no stored target moves.
--
-- `display_order` is not added — it has been on this table since it was created
-- and read by nothing. `mixCategories()` ordered by name, so the column was a
-- promise the offer list never kept.
alter table product_formulations
  add column if not exists offer_for_mix boolean not null default true;

-- The residual is "Other", and it is where value goes when a product names no
-- formulation at all. Shares have to add up, so it can no more be taken off the
-- offer list than it can be retired — the same rule `setLevelActive` already
-- enforces for `active`, and it is enforced here as well because a constraint is
-- the half that survives somebody writing SQL by hand.
alter table product_formulations
  drop constraint if exists product_formulations_residual_offered;
alter table product_formulations
  add constraint product_formulations_residual_offered
  check (not is_residual or offer_for_mix);
