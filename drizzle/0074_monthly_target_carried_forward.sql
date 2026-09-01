-- A customer's target for a new month starts as last month's MANUAL one,
-- copied forward by `seedMonthlyTargets`, unless a manager sets a real one
-- for that month first. `carried_forward` is how the screen tells a carried
-- decision apart from one made this month, the same as sales_targets'
-- column of the same name.
--
-- Every row that already exists is either a real, typed target or a
-- trailing-average default — it defaults to false and nothing already
-- saved is reclassified as a carry-over.
ALTER TABLE "monthly_targets" ADD COLUMN "carried_forward" boolean DEFAULT false NOT NULL;
