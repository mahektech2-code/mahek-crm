-- ---------------------------------------------------------------------------
-- WHAT THE HOT SCREENS ACTUALLY COST, measured on the real book.
--
-- Read-only and safe on production: every statement is a SELECT or an EXPLAIN
-- of one, inside a READ ONLY transaction that ends in ROLLBACK. It writes
-- nothing, locks nothing for longer than the read, and can be interrupted.
--
-- NO psql META-COMMANDS. Section headings are ordinary SELECTs, so this runs
-- through any client — psql in the container, a GUI over the SSH tunnel, or a
-- driver — and so that every line of it could be executed and checked before
-- it was handed to anybody. `\timing` would have been a nicety; EXPLAIN
-- ANALYZE reports its own execution time, which is the number that matters.
--
-- WHY A .sql FILE AND NOT A SCRIPT. The droplet runs a production image with
-- no tsx and no dev dependencies, so `npm run jobs` cannot help here — the one
-- thing that is definitely installed is the Postgres in the container beside
-- the app. Run it there:
--
--   docker compose exec -T postgres \
--     psql -U mahek -d mahekone -f - < scripts/perf-audit.sql > perf.txt
--
-- Or from a laptop through the tunnel DEPLOY.md documents:
--
--   ssh -N -L 5433:127.0.0.1:5432 deploy@<droplet-ip> &
--   psql "postgres://mahek:<password>@127.0.0.1:5433/mahekone" -f scripts/perf-audit.sql
--
-- WHAT IT IS NOT. These are the SHAPES of the reads the screens make, not the
-- statements Drizzle emits character for character: the real ones are built
-- inside functions that need a signed-in user for scope, and impersonating one
-- from a script would measure the seam as much as the query. Each block names
-- the function it mirrors — if that function changes, this changes with it, or
-- it measures something the app no longer does.
--
-- EVERY BLOCK IS UNSCOPED, which is a manager on Team view: the widest answer
-- any screen has to produce, and the one that decides whether the app is fast.
-- ---------------------------------------------------------------------------

begin;
set transaction read only;
-- A slow read is the thing being measured; a read that hangs is not worth
-- waiting for on a box with ten connections.
set local statement_timeout = '120s';

select '=== 0. THE BOOK ===========================================================' as section;

select
  (select count(*) from customers)        as customers,
  (select count(*) from customers where status <> 'deactivated') as customers_live,
  (select count(*) from bills)            as bills,
  (select count(*) from orders)           as orders,
  (select count(*) from calls)            as calls,
  (select count(*) from reminders)        as reminders,
  (select count(*) from wa_messages)      as wa_messages,
  (select count(*) from payment_receipts) as receipts;

select relname as table, pg_size_pretty(pg_total_relation_size(c.oid)) as total
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by pg_total_relation_size(c.oid) desc
 limit 12;

select '=== 1. listCustomers() — the WHOLE BOOK, five subqueries a row ===========' as section;
select '--- /crm/whatsapp and /crm/reminders call this to fill a picker.' as section;

explain (analyze, buffers, timing)
select customers.*,
       (select name from users u where u.id = customers.owner_id) as owner_name,
       case when customers.kind = 'lead'
            then (select name from users u where u.id = customers.owner_id)
            else coalesce(customers.sales_person_name,
                          (select name from users u where u.id = customers.sales_am_id),
                          (select name from users u where u.id = customers.owner_id))
       end as sales_am_name,
       coalesce((select name from users u where u.id = customers.back_office_am_id),
                customers.back_office_name) as back_office_name,
       (select count(*)::int from complaints
         where complaints.customer_id = customers.id
           and complaints.status in ('open','in_progress','awaiting_customer')) as open_complaints,
       (select count(*)::int from orders o
         where o.delivery_customer_id = customers.id) as delivered_orders,
       (select count(*)::int from customer_distributors d
         where d.distributor_customer_id = customers.id) as served_shops,
       (select json_build_object('kind', c.next_step_kind, 'date', c.next_step_date::text)
          from calls c
         where c.customer_id = customers.id and c.next_step_kind is not null
         order by c.started_at desc, c.id desc limit 1) as next_step
  from customers
  left join users on users.id = customers.owner_id
 order by customers.name asc;

select '=== 2. listBills() UNFILTERED — every bill, joined, sorted ==============' as section;
select '--- /crm/whatsapp calls this with no filter, to find one row per customer.' as section;

explain (analyze, buffers, timing)
select bills.*, customers.name as customer_name, customers.id as customer_id
  from bills
  join customers on customers.id = bills.customer_id
 order by bills.bill_date desc;

select '--- 2b. what that read is actually FOR: the oldest open bill per customer.' as section;
select '--- If this is fast and the one above is slow, the fix is this query.' as section;

explain (analyze, buffers, timing)
select distinct on (b.customer_id)
       b.customer_id, b.bill_no, b.due_date
  from bills b
 where b.amount > b.paid_amount
   and b.payment_position <> 'unstated'
 order by b.customer_id, b.due_date asc;

select '=== 3. The queue candidate scan (queueCandidatesFor) =====================' as section;
select '--- Abridged: five of its sixteen per-customer subqueries, the heavy ones.' as section;
select '--- Built once per user per day, then snapshotted — this is that build.' as section;

explain (analyze, buffers, timing)
select customers.id,
       exists (select 1 from calls c
                where c.customer_id = customers.id
                  and c.started_at >= (current_date::timestamptz)) as called_today,
       (select name from users u where u.id = customers.owner_id) as owner_name,
       (select percentile_cont(0.5) within group (order by o.total_amount)
          from orders o
         where o.customer_id = customers.id
           and o.status not in ('cancelled','pending_approval','declined')
           and o.ordered_at >= now() - interval '6 months') as median_order,
       (select count(*)::int from reminders r
         where r.customer_id = customers.id and r.status = 'pending') as open_reminders,
       (select max(m.confirmed_sent_at) from wa_messages m
         where m.customer_id = customers.id
           and m.status in ('sent','sent_manually','delivered','read')) as last_whatsapp
  from customers
 where customers.status <> 'deactivated';

select '=== 4. The customers list page (listCustomersPage) =======================' as section;
select '--- 4a. the aggregate strip: one pass over everything the filters match.' as section;

explain (analyze, buffers, timing)
select count(*)::int as total,
       coalesce(sum(customers.outstanding), 0)::bigint as outstanding,
       count(*) filter (where customers.slow_payer)::int as slow_payers,
       count(*) filter (where customers.kind = 'customer' and not customers.third_party)::int as direct,
       count(*) filter (where customers.kind = 'lead' and not customers.third_party)::int as leads,
       count(*) filter (where customers.third_party)::int as third_parties
  from customers;

select '--- 4b. one page of twenty-five. This is the part that should be cheap.' as section;

explain (analyze, buffers, timing)
select customers.id, customers.name, customers.city, customers.outstanding
  from customers
 order by customers.name asc
 limit 25 offset 0;

select '--- 4c. the same page, deep. OFFSET walks everything it skips.' as section;

explain (analyze, buffers, timing)
select customers.id, customers.name, customers.city, customers.outstanding
  from customers
 order by customers.name asc
 limit 25 offset 5000;

select '=== 5. listAmFilterOptions() — two DISTINCTs, EVERY page load ============' as section;
select '--- On coalesce expressions, so no index can serve them.' as section;

explain (analyze, buffers, timing)
select distinct btrim(case when customers.kind = 'lead'
       then (select name from users u where u.id = customers.owner_id)
       else coalesce(customers.sales_person_name,
                     (select name from users u where u.id = customers.sales_am_id),
                     (select name from users u where u.id = customers.owner_id))
  end) as name
  from customers
 where btrim(coalesce(customers.sales_person_name, '')) is not null;

select '=== 6. listReminders() — every reminder ever, all statuses ==============' as section;

explain (analyze, buffers, timing)
select reminders.*, customers.name, users.name
  from reminders
  join customers on customers.id = reminders.customer_id
  join users on users.id = reminders.assigned_user_id
 order by reminders.due_date asc;

select '=== 7. listMessages() — newest 300, ordered by an unindexed column =======' as section;

explain (analyze, buffers, timing)
select wa_messages.*, customers.name
  from wa_messages
  join customers on customers.id = wa_messages.customer_id
 order by wa_messages.prepared_at desc
 limit 300;

select '=== 8. INDEXES THAT ARE NEVER USED ======================================' as section;
select '--- Every one costs writes. Zero scans after a month of traffic is a' as section;
select '--- candidate for removal; low scans on a big table is a question.' as section;

select relname as table, indexrelname as index, idx_scan as scans,
       pg_size_pretty(pg_relation_size(indexrelid)) as size
  from pg_stat_user_indexes
 where schemaname = 'public'
 order by idx_scan asc, pg_relation_size(indexrelid) desc
 limit 25;

select '=== 9. SEQUENTIAL SCANS =================================================' as section;
select '--- A big table read sequentially many times is a missing index.' as section;

select relname as table, seq_scan, seq_tup_read, idx_scan,
       n_live_tup as rows
  from pg_stat_user_tables
 where schemaname = 'public' and n_live_tup > 1000
 order by seq_tup_read desc
 limit 15;

rollback;

select 'Done. Nothing was written — the transaction was rolled back.' as section;
