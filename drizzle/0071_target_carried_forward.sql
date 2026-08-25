-- A person's target for a new month starts as last month's PUBLISHED one,
-- copied forward by `copyForwardSalesTargets`, unless a manager sets a real
-- one for that month first. `carried_forward` is how the screen tells the two
-- apart: a manager who has not looked at this month at all should not read a
-- populated row as a decision somebody made for it.
--
-- Every row that already exists is a real, typed target — it defaults to
-- false and nothing already saved is reclassified as a carry-over.
ALTER TABLE "sales_targets" ADD COLUMN "carried_forward" boolean DEFAULT false NOT NULL;
