-- "Do they have a godown?" has two valid answers and the gate accepted one.
--
-- `has_dealer_network` and `has_warehouse` shipped in 0097 as NOT NULL DEFAULT
-- false, beside four verification flags that are correctly shaped that way: a
-- verification is a task somebody completes, so `false` means "not done yet"
-- and §11's gate is right to hold out for `true`.
--
-- These two are not tasks. They are facts about the distributor, and a
-- candidate who honestly has no godown could never satisfy a condition
-- demanding `true` — so they could never reach `management_review`, and the
-- only route through the form was to lie on it. That is the worst shape a
-- required field can take: it does not block bad data, it manufactures it.
--
-- Null is now "nobody has asked"; either boolean is an answer, and the gate
-- tests that one was given. Existing rows all hold the default `false`, which
-- is indistinguishable from a real "no" — and that is exactly why they are left
-- alone rather than nulled: this shipped hours ago and holds no production
-- rows, and inventing an unanswered state for somebody's recorded answer would
-- be the same mistake in the other direction.
ALTER TABLE "distributor_profiles" ALTER COLUMN "has_dealer_network" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "distributor_profiles" ALTER COLUMN "has_dealer_network" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "distributor_profiles" ALTER COLUMN "has_warehouse" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "distributor_profiles" ALTER COLUMN "has_warehouse" DROP DEFAULT;
