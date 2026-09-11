-- §E — the Prospect validation call, and the answers it is worth making for.
--
-- Its own table rather than columns on `customers`, because it is an EVENT and
-- not a fact about the account. A lead can be validated twice — the first call
-- reached a receptionist, the second reached the proprietor — and a set of
-- columns on the customer would keep only the second and quietly destroy the
-- first. The one that matters is usually the first, because it is the one that
-- says the salesman's report did not match what the shop said.
create table if not exists "mbos_lead_validations" (
  "id" text primary key,

  -- The lead. `cascade` because a validation of a record that no longer exists
  -- is not a thing anybody can act on.
  "customer_id" text not null references "customers"("id") on delete cascade,
  -- Who made the call. Not necessarily the Lead Manager: §E says "Lead
  -- Manager/Telecaller", and on a nine-person team it is whoever is free.
  "called_by_user_id" text not null references "users"("id"),

  "called_at" timestamptz not null default now(),
  -- Reached, or not. A call nobody answered is still a call that was made, and
  -- recording only the successful ones makes the follow-up look effortless.
  "reached" boolean not null default true,

  -- §E's four questions. Free text, all nullable: a customer who has plenty to
  -- say about dispatch and nothing about quality is the ordinary case, and a
  -- form that demands all four gets four sentences of filler.
  "product_feedback" text,
  "quality_feedback" text,
  "dispatch_feedback" text,
  "salesman_feedback" text,

  -- What the shop itself says it needs, as against what the salesman reported.
  -- The whole point of the call is that these two can differ, so they are
  -- stored HERE and never written straight over the lead's own columns.
  "confirmed_requirement" text,
  "confirmed_monthly_volume_litres" integer,
  "confirmed_competitor" text,
  "confirmed_potential_paise" bigint,

  -- The Lead Manager's decision. `pending` is a call that was made and left
  -- undecided, which is a real state and not a missing value.
  "verdict" text not null default 'pending',
  "verdict_reason" text,
  "notes" text,

  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "created_by_id" text,
  "updated_by_id" text
);

-- The only two questions asked of this table: this lead's calls newest first,
-- and the caller's own recent ones.
create index if not exists "mbos_lead_validations_customer_idx"
  on "mbos_lead_validations" ("customer_id", "called_at" desc);
create index if not exists "mbos_lead_validations_caller_idx"
  on "mbos_lead_validations" ("called_by_user_id", "called_at" desc);
