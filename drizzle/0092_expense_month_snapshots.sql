-- What the field cost in a month, frozen at the end of it.
--
-- Requirement 72. A SNAPSHOT, not a cache: a trend derived live from the
-- ledger restates history every time an old claim is corrected or a manager
-- approves a day from three months ago, so the shape of the last twelve months
-- would change under the owner's eye with nothing having happened.
-- `customer_health_snapshots` made the same argument first and this follows it.
--
-- The nightly pass rewrites the CURRENT month and never a past one, which is
-- what makes a closed month correct for free — it simply stops being
-- overwritten, so no job has to fire on exactly the right day.

CREATE TABLE IF NOT EXISTS expense_month_snapshots (
  id text PRIMARY KEY,
  period text NOT NULL,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  travel_paise bigint NOT NULL DEFAULT 0,
  food_paise bigint NOT NULL DEFAULT 0,
  lodging_paise bigint NOT NULL DEFAULT 0,
  local_transport_paise bigint NOT NULL DEFAULT 0,
  other_paise bigint NOT NULL DEFAULT 0,
  awaiting_paise bigint NOT NULL DEFAULT 0,
  revenue_paise bigint NOT NULL DEFAULT 0,
  metres bigint NOT NULL DEFAULT 0,
  visit_count integer NOT NULL DEFAULT 0,
  new_customer_count integer NOT NULL DEFAULT 0,
  salesman_count integer NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- NULLS NOT DISTINCT because the company-wide row carries a null user, and two
-- of those would otherwise both be storable — which would double the whole
-- trend on the second nightly run of any month.
CREATE UNIQUE INDEX IF NOT EXISTS expense_month_snapshots_key
  ON expense_month_snapshots (period, user_id) NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS expense_month_snapshots_period_idx
  ON expense_month_snapshots (period);
