-- EVERY SCOPED LIST IN THE PRODUCT BEGINS WITH A SEQUENTIAL SCAN OF THE BOOK.
--
-- `scopedToUsers` is the first clause of the queue, the collections worklist,
-- the bills ledger, the complaints list, the inactive watch, the customers
-- list in two apps and global search — and none of the four seats it ORs
-- together could be answered from an index, because the first of them is a
-- CASE expression rather than a column. Measured on prod: 5,925 rows walked
-- to return 116, 11.9 ms, 579 buffer pages, six or more times per load of the
-- customers page. `customers` has served 88,386 sequential scans and read 205
-- million tuples doing it.
--
-- None of these is slow in isolation, which is exactly why none of them was
-- noticed. The cost that matters on a droplet with one shared vCPU is not the
-- millisecond, it is the buffer churn: 579 pages per clause per screen,
-- competing for the same shared_buffers as everything else the page needs.
--
-- Nothing here changes an answer. Every statement in this file is an index,
-- so the only thing that moves is how the planner reaches rows it was already
-- returning.
--
-- ON PRODUCTION, APPLY THESE `CONCURRENTLY` BY HAND. A plain CREATE INDEX
-- takes a SHARE lock and blocks every write to the table for the duration —
-- on `customers`, `orders` and `bills` that is the sheet sync and the whole
-- CRM. drizzle-kit runs its migrations inside ONE transaction and
-- `CREATE INDEX CONCURRENTLY` cannot run in one, so it cannot be written that
-- way here; the file is honest about the fact instead. See the report in
-- DEPLOY.md's sense: build them concurrently first, then let this migration
-- run, where every `IF NOT EXISTS` finds its index already present and does
-- nothing.

/* ------------------------------------------------ 1. the scope predicate */

-- THE EXPRESSION BELOW IS A COPY OF `ASSIGNED_TO_SQL`, and it has to stay one.
--
-- Postgres will only use an expression index where the query's expression
-- matches the index's — so this index exists at the pleasure of a constant in
-- `src/lib/access-control.ts`, and an edit there that nobody mirrors here does
-- not break anything, it silently returns every scoped list in the product to
-- the sequential scan this file was written to remove. That is the worst shape
-- a regression can have: correct answers, quietly paid for.
--
-- `src/lib/assigned-to-index.test.ts` reads both files and fails the build if
-- the two ever stop agreeing, which is why the copy is safe to keep.
--
-- The expression is IMMUTABLE — column references and `coalesce` only, no
-- clock, no locale, no configuration — which is what makes it indexable at
-- all.
CREATE INDEX IF NOT EXISTS customers_assigned_to_idx
  ON customers ((
  case when customers.kind = 'lead'
       then customers.owner_id
       when customers.am_decided_at is not null
       then customers.sales_am_id
       else coalesce(customers.sales_am_id, customers.owner_id)
  end));
--> statement-breakpoint

-- The second leg of the same OR. The back office seat is a plain column and
-- was simply never indexed, though `scopedToUsers` has read it since the day
-- it was widened to stop giving the back office team an empty CRM.
--
-- PARTIAL, because most accounts name nobody: the index then holds only the
-- rows that can ever match an `in (…)`, and costs the write path nothing on
-- the ones that cannot. The other two seats — `lead_manager_id` and
-- `relationship_owner_id` — already have indexes of their own.
CREATE INDEX IF NOT EXISTS customers_back_office_idx
  ON customers (back_office_am_id)
  WHERE back_office_am_id IS NOT NULL;
--> statement-breakpoint

-- AND THE THIRD LEG, WHICH IS THE ONE THAT DECIDED WHETHER ANY OF THIS WORKED.
--
-- `customers_lead_manager_idx` looks like an index on this seat and is not:
-- it is `(lead_manager_id, lead_stage) WHERE lead_stage IS NOT NULL`, built
-- for the lead worklist. `scopedToUsers` asks `lead_manager_id in (…)`, which
-- does not imply `lead_stage is not null`, so Postgres cannot use it here —
-- and ONE unindexable arm of an OR sends the WHOLE clause to a sequential
-- scan. Measured on a synthetic book of 6,001 rows: with the expression index
-- built and this one missing, the four-way OR still seq-scanned 273 pages even
-- with `enable_seqscan` off, because there was no other plan to have. With it,
-- the planner builds a BitmapOr and the scan disappears.
--
-- That is the thing to remember about the whole of this file: an index that
-- answers three arms of a four-arm OR buys nothing at all. It is not a partial
-- win, it is no win.
CREATE INDEX IF NOT EXISTS customers_lead_manager_seat_idx
  ON customers (lead_manager_id)
  WHERE lead_manager_id IS NOT NULL;
--> statement-breakpoint

/* --------------------------------------------------------- 2. the orders */

-- `orders.user_id` had NO index at all, on a table that has read 157 million
-- tuples sequentially.

-- The queue's median-order subplan, which is what decides what a sales call is
-- WORTH: the customer's own recent counting orders, newest first. It runs once
-- per candidate customer and accounted for 19,414 of the queue scan's 30,510
-- buffer pages on its own.
--
-- `total_amount` and `user_id` are INCLUDEd rather than made key columns: they
-- are read and never filtered on, so carrying them in the leaf pages makes the
-- subplan index-only without paying to keep them sorted. Drizzle has no way to
-- express INCLUDE, which is why this one lives here and is only noted in
-- schema.ts.
CREATE INDEX IF NOT EXISTS orders_customer_status_ordered_idx
  ON orders (customer_id, status, ordered_at DESC)
  INCLUDE (total_amount, user_id);
--> statement-breakpoint

-- Whose order it was, newest first — read by EOD and by the performance
-- actuals, both of which ask "what did this person sell in this window".
--
-- PARTIAL on the column being present, because an order the SHEET wrote
-- carries no `user_id`: nobody in MahekOne took it, and 10,867 of 10,957
-- orders are that shape. Indexing the nulls would be indexing the whole table
-- to answer a question none of them can be the answer to.
CREATE INDEX IF NOT EXISTS orders_user_ordered_idx
  ON orders (user_id, ordered_at DESC)
  WHERE user_id IS NOT NULL;
--> statement-breakpoint

-- The third index this section was going to carry, on
-- `orders.delivery_customer_id`, is NOT here: `drizzle/0057` already built it.
-- The customers list's per-row `count(*) from orders where
-- delivery_customer_id = customers.id` is therefore already indexed, and a
-- second copy under a different name would cost the write path twice to answer
-- one question.

/* ------------------------------------------- 3. the customer record's page */

-- A CUSTOMER RECORD IS A FIXED-LENGTH PAGE, and the reads behind it are capped
-- — but a cap on what is RETURNED is not a cap on what is read. Each timeline
-- branch was materialising the account's whole history, sorting it, and
-- keeping ten: about 2,500 rows walked to render eleven.
--
-- Each of these is (customer, when DESC, id DESC) because that is the sort the
-- keyset cursor pages on, tiebreaker included — `order by at desc` alone
-- leaves a thousand bills sharing a handful of midnight timestamps in whatever
-- order the planner fancies, which is a row on two pages and another on none.
-- The id is in the index so the tiebreaker is answered there too.
CREATE INDEX IF NOT EXISTS calls_customer_started_idx
  ON calls (customer_id, started_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS bills_customer_date_idx
  ON bills (customer_id, bill_date DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS payment_receipts_customer_received_idx
  ON payment_receipts (customer_id, received_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS wa_messages_customer_prepared_idx
  ON wa_messages (customer_id, prepared_at DESC, id DESC);
--> statement-breakpoint

/* ----------------------------------------------------- 4. the open bills */

-- "Who owes us" is 430 bills of 10,859, and the predicate that says which is a
-- comparison between two columns — which no ordinary index can answer, so
-- Outstanding reads the entire ledger to find four hundred rows.
--
-- A partial index CAN, because `amount > paid_amount` is evaluated once at
-- write time rather than at read time. The result is a few kilobytes that
-- answers the question exactly, and a bill leaves it by being settled, which
-- is precisely the event that should take a customer off the collections list.
CREATE INDEX IF NOT EXISTS bills_open_customer_idx
  ON bills (customer_id)
  WHERE amount > paid_amount;
--> statement-breakpoint

/* ------------------------------------------ 5. the collections and EOD seats */

-- Whose collections call it was, newest first. `follow_up_attempts` carried
-- only a customer index, so every EOD figure and every "what did this
-- telecaller do today" walked the table.
CREATE INDEX IF NOT EXISTS follow_up_attempts_user_idx
  ON follow_up_attempts (user_id, attempted_at DESC);
--> statement-breakpoint

-- And who recorded the money. `payments` is 22,586 rows and has read 43.7
-- million tuples sequentially; the allocation lines are read per person per
-- day by the same EOD screens.
--
-- PARTIAL for the same reason the orders one is: a payment line the sheet
-- import wrote names nobody, and nobody is never the answer to "whose".
CREATE INDEX IF NOT EXISTS payments_recorded_by_idx
  ON payments (recorded_by_id, paid_at DESC)
  WHERE recorded_by_id IS NOT NULL;
--> statement-breakpoint

/* ---------------------------------------------------- 6. the search box */

-- Global search is a four-way OR over a customer's name, city, contact and
-- code, plus the bill number — and only `customers.name` had a trigram index,
-- which means the planner could not use it: one unindexable arm of an OR sends
-- the whole clause to a sequential scan, so the index that existed was doing
-- nothing for the query it was built for.
--
-- These are declared here and not in schema.ts for the reason `drizzle/0008`
-- and `drizzle/0013` already give: Drizzle cannot express an operator-class
-- index. `pg_trgm` was created by 0008.
--
-- Trigram rather than a plain b-tree because a name typed mid-call is a name
-- typed badly, and because these are all `ilike '%…%'` — a b-tree cannot
-- answer a leading wildcard at all.
CREATE INDEX IF NOT EXISTS bills_bill_no_trgm_idx
  ON bills USING gin (bill_no gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS customers_city_trgm_idx
  ON customers USING gin (city gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS customers_contact_person_trgm_idx
  ON customers USING gin (contact_person gin_trgm_ops);
