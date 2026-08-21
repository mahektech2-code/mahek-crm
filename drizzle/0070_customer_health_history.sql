-- Where each customer stood at the end of a month.
--
-- The one figure the owner dashboard cannot derive. Everything else on it is a
-- read of the present or a sum over a window; "how many customers came BACK"
-- is a comparison between two readings, and the earlier one is gone the moment
-- it stops being true.
--
-- Why it matters more than the counts: a book with 145 at risk in both months
-- looks stable and may be 145 different people, half of them recovered and
-- half newly slipping. The counts cannot tell those apart. This can, and it is
-- the only figure in the module that says whether the telecalling team is
-- actually getting anybody back.
--
-- WRITTEN NIGHTLY over the CURRENT month's row, which is what makes a closed
-- month correct for free: it stops being overwritten on the last night of the
-- month, so the row IS the band as it stood at month end. No month-end job has
-- to fire on exactly the right day to be right.
--
-- A SNAPSHOT, NOT A CACHE. A cache is rebuilt when the answer changes;
-- rebuilding this would destroy the thing it exists for. Nothing recomputes a
-- past month and nothing may learn to — the same rule `calls.next_step_*`
-- follows. It also cannot be backfilled: before the first night this runs
-- there is no earlier reading, and the screen says so rather than drawing a
-- movement of zero.
--
-- The BAND itself is not defined here. It is `engines/inactivity.ts`, measured
-- in multiples of the customer's OWN cycle, and `dormant` is deliberately the
-- existing `inactive.cycleMultiplier` rather than a second number — one answer
-- to "has this customer gone quiet", so the Call Log and the owner's screen
-- cannot disagree about the same account.

CREATE TABLE "customer_health_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"period" text NOT NULL,
	"band" text NOT NULL,
	-- Kept ON the row: a customer's cycle moves as they order, so a snapshot
	-- storing only the band could never be explained afterwards. "Why was this
	-- account dormant in March" has no answer once the cycle it was judged
	-- against has changed underneath it.
	"cycle_days" integer,
	-- Hundredths of a cycle: 250 is 2.5 cycles elapsed. Integers, like money.
	"cycles_elapsed_bp" integer,
	"days_overdue" integer,
	"last_order_date" date,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_health_snapshots" ADD CONSTRAINT "customer_health_snapshots_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- One reading per customer per month, so the nightly pass overwrites rather
-- than stacking thirty rows a month per customer.
CREATE UNIQUE INDEX "customer_health_snapshots_key" ON "customer_health_snapshots" USING btree ("customer_id","period");--> statement-breakpoint
CREATE INDEX "customer_health_snapshots_period_idx" ON "customer_health_snapshots" USING btree ("period","band");
