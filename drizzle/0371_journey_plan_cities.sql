-- A journey day can name SEVERAL cities. `city` stays the PRIMARY city — the one
-- every handset already filters its shop list by — and `cities` carries the full,
-- ordered list only where the office named more than one. NULL means "just
-- `city`", which is every row that exists today, so nothing is backfilled and no
-- existing day changes meaning. Never a joined string in `city`: a handset
-- matches shops against that one value and would find none.
ALTER TABLE "mbos_journey_plans" ADD COLUMN IF NOT EXISTS "cities" text[];
