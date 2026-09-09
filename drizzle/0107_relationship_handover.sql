-- §Q — who owns the RELATIONSHIP, once the account is a customer.
--
-- The brief asks for the account to become a customer on the second order and
-- for the relationship to move to a customer manager at the same moment. The
-- first half was answered elsewhere and answered differently: `kind` flips on
-- the FIRST order, because between order one and two the account has been
-- billed, owes money and has a buying cycle, and a lead carries none of that
-- machinery. See `lead-conversion-service.ts` for the whole argument.
--
-- What that answer does not supply is the second half. "The relationship moved
-- to somebody else" and "this account is now a customer" are two different
-- facts about two different things, and the brief had them riding on one
-- column. These are the second fact, on its own marker, exactly as the note in
-- the conversion service promised.

-- A fourth kind of seat change, so the history table already in place carries
-- this one too rather than a second table being invented for it.
--
-- Added here and used only by application code that runs after this commits.
-- Postgres refuses to use an enum value in the transaction that adds it and
-- drizzle-kit applies every pending migration in one, so no later migration in
-- this batch may write it. Same rule as `app_id`, `order_status` and
-- `mbos_lead_stage` before it.
alter type "am_role" add value if not exists 'relationship';

-- WHO RUNS THIS ACCOUNT NOW.
--
-- Deliberately NOT `sales_am_id`. That seat decides who is credited for an
-- account's orders and whose target it counts toward, and moving it is
-- `customer.reassign` — accounts' and admin's, because a manager moving it is a
-- manager moving numbers between their own people. A handover moves neither a
-- rupee nor a target, which is exactly why it can be a manager's to make.
alter table "customers" add column if not exists "relationship_owner_id" text references "users"("id");

-- WHEN it happened, and the only thing that says a handover has happened at
-- all. Whether one is OUTSTANDING is derived from this being null on a
-- converted account -- never stored, because a stored flag is a cache with
-- nothing rebuilding it, and it would go stale the first time somebody set the
-- seat by any path that forgot to clear it.
alter table "customers" add column if not exists "handed_over_at" timestamptz;

-- "What is on my plate" is the question this seat is read for.
create index if not exists "customers_relationship_owner_idx"
  on "customers" ("relationship_owner_id");

-- The worklist: converted, and nobody has taken the relationship on. It should
-- be short and it is the whole point of the marker, so it gets its own partial
-- index rather than a sequential scan over the book.
create index if not exists "customers_handover_pending_idx"
  on "customers" ("lead_converted_at")
  where "handed_over_at" is null and "lead_converted_at" is not null;
