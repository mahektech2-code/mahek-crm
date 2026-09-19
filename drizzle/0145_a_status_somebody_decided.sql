-- A STATUS SOMEBODY DECIDED IS NOT THE SHEET'S TO RESTATE.
--
-- The third mark of its kind, after `orders.approved_at` and
-- `customers.am_decided_at`, and it exists because the party projection had
-- exactly half the rule. It already refused to REACTIVATE an account a person
-- had closed inside the CRM -- `deactivation_reason <> 'Marked Deactive on the
-- customer master'` -- and nothing whatever guarded the other direction: an
-- account a person brought BACK was re-closed on the very next pass, because
-- the Deactive branch above it writes unconditionally.
--
-- In production that ran three times on one shop. An admin reactivated it on
-- 4 Sep and again at 10:23 on 8 Sep; the sync re-closed it at 10:39, sixteen
-- minutes later, and a third correction was undone within the half hour. The
-- shop took four dispatched orders worth about thirty lakh while sitting
-- `deactivated` and therefore absent from every Call Log -- `queue_inputs`
-- filters the status BEFORE it reaches the scope filter, so no seat and no
-- score could have put it back on a list.
--
-- Null means NOT DECIDED, which is every row written before this and every
-- account the spreadsheet alone has ever spoken for. That is what lets this
-- ship without moving a figure: an undecided account goes on tracking the
-- sheet exactly as it did.
alter table "customers"
  add column if not exists "status_decided_at" timestamp with time zone;

-- Backfill from the audit log, which is where the decisions already are.
--
-- Only `customer.deactivate` and `customer.reactivate` -- the two actions that
-- actually move the status. The `_rejected` pair are a manager declining a
-- REQUEST and leave the status where it stood, so they decide nothing about
-- it and must not claim to.
--
-- The latest such row wins: a shop closed in March and reopened in August was
-- decided in August, and taking the earliest would date the mark to a decision
-- that has since been reversed.
--
-- This is what makes the fix retrospective rather than prospective. Without it
-- the nine accounts somebody has already reactivated stay unprotected until
-- somebody notices and does it a fourth time.
update "customers" c
   set "status_decided_at" = d.decided_at
  from (
        select "entity_id" as customer_id, max("at") as decided_at
          from "audit_log"
         where "entity_type" = 'customer'
           and "action" in ('customer.deactivate', 'customer.reactivate')
           and "entity_id" is not null
         group by "entity_id"
       ) d
 where c."id" = d.customer_id
   and c."status_decided_at" is null;

-- Read by the party projection on every pass, over the whole book, to decide
-- whether it may touch the status at all.
create index if not exists "customers_status_decided_at_idx"
  on "customers" ("status_decided_at");
