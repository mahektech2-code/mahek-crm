-- WHAT A CALL IS WORTH, CACHED — because it was being derived per customer,
-- per page load, on the two screens a telecaller and a manager live in.
--
-- `queueInputs` carried this as a correlated subquery:
--
--     select percentile_cont(0.5) within group (order by o.total_amount)
--       from orders o where o.customer_id = customers.id and <approved>
--        and o.ordered_at >= now() - <lookback>
--
-- one `percentile_cont` per candidate, over that customer's order history,
-- every time the Call Log or the dashboard was opened. On the real book it was
-- measured at 19,414 of the candidate scan's 30,510 shared buffers — the single
-- largest component of the single most expensive statement in the app.
--
-- It is a CACHE in exactly the sense this codebase already means: a derived
-- value, never hand-edited, rebuilt by a named function in `lib/recompute.ts`.
-- It sits beside `avg_order_value`, `cycle_days` and `cycle_confidence`, which
-- are derived from the same rows by the same function — `writeCycle` already
-- had this data in hand and was throwing it away.
--
-- A median rather than a mean, for the reason the subquery's own comment gave:
-- one unusual order repeated should not decide where a shop sits on the calling
-- list for a year, and an average is exactly how it would.
alter table "customers" add column if not exists "typical_order_paise" bigint not null default 0;
--> statement-breakpoint

-- BACKFILLED HERE, not left at the default, so no figure moves on deploy.
--
-- The column feeds `callValuePaise`, which orders the calling list within a
-- reason. Shipping it as zeroes would have every customer rank as worthless
-- until the first nightly ran — the whole book reordered for a day, with
-- nothing on any screen saying why. The window is read from `app_settings`
-- rather than assumed, because a team that has already tuned
-- `queue.orderValueLookbackDays` must be backfilled on THEIR window, not on
-- the registry's default; `coalesce` covers a database where the setting has
-- not been written yet.
update "customers" c
   set "typical_order_paise" = coalesce((
         select percentile_cont(0.5) within group (order by o.total_amount)
           from "orders" o
          where o.customer_id = c.id
            -- `::text` IS LOAD BEARING, and leaving it off fails only from
            -- scratch. drizzle-kit applies every pending migration in ONE
            -- transaction, and Postgres refuses to USE an enum value added in
            -- that same transaction — `in_transit` and `delivered` were added
            -- to `order_status` by an earlier migration, so naming them as
            -- enum literals here is exactly the trap AGENTS.md records for
            -- app ids. It passes against any database that already has the
            -- enum committed, which is every developer's, and fails in CI and
            -- on a fresh clone. Comparing as text needs no enum member: a
            -- status the enum does not yet carry cannot be on any row anyway.
            and o.status::text in ('captured', 'confirmed', 'dispatched', 'in_transit', 'delivered')
            and o.ordered_at >= now() - make_interval(days => coalesce(
                  (select (value #>> '{}')::int from "app_settings"
                    where key = 'queue.orderValueLookbackDays'), 365))
       ), 0)::bigint;

-- The ranking reads it for every candidate in scope on every load, so it is
-- worth its own index only where the planner would use one; it is read as a
-- plain column off a row already being fetched, so no index is added here.
