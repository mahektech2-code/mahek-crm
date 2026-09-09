-- 2-§P — what an account could be worth, against what it is worth.
--
-- `customers.potential` is an enum of high/medium/low, which orders a book and
-- cannot be subtracted from anything. The brief asks for a monthly potential, an
-- annual one, current sales and the GAP between them, and a gap needs a number.
--
-- The lead columns already hold this for a lead
-- (`lead_estimated_potential_paise`), and it stops being readable the moment the
-- lead becomes a customer — the one point at which the question starts being
-- worth asking every quarter.
alter table "customers"
  add column if not exists "potential_monthly_paise" bigint;

-- WHOSE JUDGEMENT, AND WHEN.
--
-- This is not a measurement and must never be presented as one:
-- `products.price_source` is still `unset`, so nothing in MahekOne can derive
-- what a shop could spend. It is a salesman's estimate, and an estimate with no
-- date on it is one nobody can weigh — "he thought this in 2024" is most of what
-- a reader needs to know about a figure like this.
alter table "customers"
  add column if not exists "potential_estimated_at" timestamptz;
alter table "customers"
  add column if not exists "potential_estimated_by_id" text references "users"("id");

-- The ANNUAL figure is deliberately absent. It is the monthly one times twelve,
-- and a stored second copy is a second copy that can disagree — somebody edits
-- the month and the year stays where it was, and two screens quote two numbers.
-- Current sales are equally derivable, from orders that already exist. Only the
-- estimate is stored, because only the estimate is a fact nothing else knows.
