-- §B and §F: a lead cannot stay a Suspect for ever, and On Hold is a real
-- answer rather than a lead nobody touched.

-- On Hold. §F asks for it beside Lost, and the two are genuinely different: a
-- lost lead is one nobody rings again and its reason is the only thing the
-- record is still worth, while a held one is a live prospect with a reason it
-- is not moving — a plant shutdown, a budget quarter, a decision maker away.
-- Keeping them in one word made every stalled lead look dead.
--
-- Added here and USED only by application code that runs after this commits.
-- Postgres refuses to use an enum value in the transaction that adds it, and
-- drizzle-kit applies every pending migration in one — so no later migration in
-- this batch may write it. Same rule as `app_id`, same reason.
alter type "mbos_lead_stage" add value if not exists 'on_hold';

-- WHY IT IS NOT MOVING.
--
-- One column for two questions that are the same question: "it is staying a
-- Suspect after three visits, why" and "it is On Hold, why". Both are somebody
-- explaining a lead that is not progressing, and splitting them would give the
-- screen two fields to read and the salesman two places to type the same
-- sentence.
--
-- Distinct from `lead_lost_reason`, which is not the same question at all —
-- that one is why we stopped, this one is why we have not started.
alter table "customers"
  add column if not exists "lead_hold_reason" text;

-- The visit count itself is NOT a column. It is `count(*)` over
-- `mbos_visits` on an index that already exists (`mbos_visits_customer_idx`),
-- read in the two queries that need it. A cached count is a cache that needs a
-- recompute path, an invalidation on every visit write, and a way to be wrong;
-- a count on an indexed column for the handful of open leads one salesman owns
-- is cheaper than the machinery to avoid it.
