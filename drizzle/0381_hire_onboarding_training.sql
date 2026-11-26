-- The Onboarding & Training PRD, in Hire.
--
-- Compensation gets its own record (incentive plan versions, other pay items,
-- the proposed basic beside the negotiated one, and an approval), the
-- background check moves off the offer onto the application, employment
-- documents and courier shipments become rows of their own, assets get an
-- append-only issue history with the employee's acknowledgement, and the
-- training engine — versioned modules and tracks, enrolments, attempts — is
-- added beside them. Everything is additive: an application on a blueprint
-- published before this keeps the flow it was published with.

-- ------------------------------------------------------------- offers
alter table "hire_offers" add column if not exists "incentive_applicable" boolean default true not null;
alter table "hire_offers" add column if not exists "incentive_plan_id" text;
alter table "hire_offers" add column if not exists "components" jsonb default '[]'::jsonb not null;
alter table "hire_offers" add column if not exists "effective_date" date;
alter table "hire_offers" add column if not exists "proposed_basic_paise" bigint;
alter table "hire_offers" add column if not exists "approval_status" text default 'not_needed' not null;
alter table "hire_offers" add column if not exists "approval_requested_at" timestamp with time zone;
alter table "hire_offers" add column if not exists "approval_requested_by_id" text references "users"("id");
alter table "hire_offers" add column if not exists "approved_by_id" text references "users"("id");
alter table "hire_offers" add column if not exists "approved_at" timestamp with time zone;
alter table "hire_offers" add column if not exists "approval_note" text;
alter table "hire_offers" add column if not exists "change_reason" text;
alter table "hire_offers" drop constraint if exists "hire_offers_approval";
alter table "hire_offers" add constraint "hire_offers_approval" check ("approval_status" in ('not_needed','pending','approved','refused'));
-- Every offer already made proposed what it says; a negotiated one inherits
-- the figure its chain started from.
update "hire_offers" set "proposed_basic_paise" = "basic_paise" where "proposed_basic_paise" is null and "negotiated_from_id" is null;
with recursive chain as (
  select id, basic_paise as root_basic from hire_offers where negotiated_from_id is null
  union all
  select o.id, c.root_basic from hire_offers o join chain c on o.negotiated_from_id = c.id
)
update "hire_offers" o set "proposed_basic_paise" = c.root_basic from chain c where c.id = o.id and o."proposed_basic_paise" is null;
update "hire_offers" set "incentive_applicable" = false where coalesce(trim("incentive"), '') = '';

-- ---------------------------------------------------------- documents
alter table "hire_documents" add column if not exists "requested_at" timestamp with time zone;
alter table "hire_documents" add column if not exists "requested_by_id" text references "users"("id");
alter table "hire_documents" drop constraint if exists "hire_documents_status";
alter table "hire_documents" add constraint "hire_documents_status" check ("verification_status" in ('requested','pending','verified','failed','manual_review','waived'));

-- ------------------------------------------------------- applications
alter table "hire_applications" add column if not exists "onboarding_completed_at" timestamp with time zone;
-- Hired under the old flow WAS the end of onboarding.
update "hire_applications" set "onboarding_completed_at" = "hired_at" where "status" = 'hired' and "onboarding_completed_at" is null;

alter table "hire_onboarding_items" drop constraint if exists "hire_onboarding_kind";
alter table "hire_onboarding_items" add constraint "hire_onboarding_kind" check ("kind" in ('asset','topic','setup','intro'));

-- --------------------------------------------------- incentive plans
create table if not exists "hire_incentive_plans" (
  "id" text primary key,
  "key" text not null,
  "version" integer not null,
  "title" text not null,
  "status" text default 'draft' not null,
  "designations" jsonb default '[]'::jsonb not null,
  "basis" text default '' not null,
  "mode" text default 'whole' not null,
  "slabs" jsonb default '[]'::jsonb not null,
  "conditions" text default '' not null,
  "effective_from" date,
  "published_at" timestamp with time zone,
  "published_by_id" text references "users"("id"),
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "created_by_id" text,
  "updated_by_id" text,
  constraint "hire_incentive_plans_status" check ("status" in ('draft','published','retired')),
  constraint "hire_incentive_plans_mode" check ("mode" in ('whole','marginal'))
);
create unique index if not exists "hire_incentive_plans_key_version" on "hire_incentive_plans" ("key","version");

-- ------------------------------------------------- background checks
create table if not exists "hire_background_checks" (
  "id" text primary key,
  "application_id" text not null references "hire_applications"("id"),
  "required" boolean default true not null,
  "status" text default 'not_started' not null,
  "method" text,
  "vendor" text,
  "initiated_on" date,
  "completed_on" date,
  "checked_by_id" text references "users"("id"),
  "remark_vault_ids" jsonb default '[]'::jsonb not null,
  "superseded_by_id" text,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "created_by_id" text,
  "updated_by_id" text,
  constraint "hire_background_checks_status" check ("status" in ('not_started','in_progress','clear','concern','not_applicable'))
);
create index if not exists "hire_background_checks_app" on "hire_background_checks" ("application_id");
-- Carried off the offer it used to live on: the current offer's word is the check.
insert into "hire_background_checks" ("id","application_id","required","status","created_at","updated_at","created_by_id")
select 'hbg_' || o.id, o.application_id,
       o.background_check <> 'not_necessary',
       case o.background_check when 'needed' then 'not_started' when 'not_necessary' then 'not_applicable' when 'in_progress' then 'in_progress' when 'clear' then 'clear' when 'flagged' then 'concern' else 'not_started' end,
       o.updated_at, o.updated_at, o.updated_by_id
  from "hire_offers" o
 where o.superseded_by_id is null
   and not exists (select 1 from hire_background_checks b where b.application_id = o.application_id);

-- --------------------------------------------- employment documents
create table if not exists "hire_doc_templates" (
  "id" text primary key,
  "key" text not null,
  "version" integer not null,
  "title" text not null,
  "body" text not null,
  "status" text default 'draft' not null,
  "published_at" timestamp with time zone,
  "published_by_id" text references "users"("id"),
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "created_by_id" text,
  "updated_by_id" text,
  constraint "hire_doc_templates_status" check ("status" in ('draft','published','retired'))
);
create unique index if not exists "hire_doc_templates_key_version" on "hire_doc_templates" ("key","version");

create table if not exists "hire_employment_docs" (
  "id" text primary key,
  "application_id" text not null references "hire_applications"("id"),
  "doc_key" text not null,
  "label" text not null,
  "template_id" text references "hire_doc_templates"("id"),
  "template_version" integer,
  "body" text default '' not null,
  "status" text default 'prepared' not null,
  "hard_copy" boolean default false not null,
  "prepared_by_id" text references "users"("id"),
  "prepared_at" timestamp with time zone default now() not null,
  "approved_by_id" text references "users"("id"),
  "approved_at" timestamp with time zone,
  "sent_by_id" text references "users"("id"),
  "sent_at" timestamp with time zone,
  "signed_on" date,
  "signed_recorded_by_id" text references "users"("id"),
  "signed_file_id" text,
  "filed_by_id" text references "users"("id"),
  "filed_at" timestamp with time zone,
  "superseded_by_id" text,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "created_by_id" text,
  "updated_by_id" text,
  constraint "hire_employment_docs_status" check ("status" in ('prepared','approved','sent','signed','filed'))
);
create index if not exists "hire_employment_docs_app" on "hire_employment_docs" ("application_id");

-- ------------------------------------------------------------ courier
create table if not exists "hire_courier_shipments" (
  "id" text primary key,
  "application_id" text not null references "hire_applications"("id"),
  "direction" text not null,
  "company" text,
  "tracking_no" text,
  "doc_keys" jsonb default '[]'::jsonb not null,
  "status" text not null,
  "due_on" date,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "created_by_id" text,
  "updated_by_id" text,
  constraint "hire_courier_shipments_direction" check ("direction" in ('outbound','return'))
);
create index if not exists "hire_courier_shipments_app" on "hire_courier_shipments" ("application_id");

create table if not exists "hire_courier_events" (
  "id" text primary key,
  "shipment_id" text not null references "hire_courier_shipments"("id"),
  "status" text not null,
  "event_on" date not null,
  "remarks" text,
  "by_id" text references "users"("id"),
  "at" timestamp with time zone default now() not null,
  constraint "hire_courier_events_status" check ("status" in ('to_be_sent','sent','delivered','awaited','return_sent','received','issue'))
);
create index if not exists "hire_courier_events_shipment" on "hire_courier_events" ("shipment_id","at");

-- The old four-value courier field becomes the shipments it described.
insert into "hire_courier_shipments" ("id","application_id","direction","status","created_at","updated_at","created_by_id")
select 'hcs_out_' || o.id, o.application_id, 'outbound',
       case when o.courier_status in ('received','received_by_staff') then 'delivered' else 'sent' end,
       o.updated_at, o.updated_at, o.updated_by_id
  from "hire_offers" o
 where o.superseded_by_id is null and o.courier_status <> 'not_sent'
   and not exists (select 1 from hire_courier_shipments s where s.application_id = o.application_id);
insert into "hire_courier_events" ("id","shipment_id","status","event_on","remarks","by_id","at")
select 'hce_' || s.id, s.id, s.status, (s.created_at at time zone 'Asia/Kolkata')::date, 'Carried over from the offer''s courier field', s.created_by_id, s.created_at
  from "hire_courier_shipments" s where s.id like 'hcs_out_%'
   and not exists (select 1 from hire_courier_events e where e.shipment_id = s.id);
insert into "hire_courier_shipments" ("id","application_id","direction","status","created_at","updated_at","created_by_id")
select 'hcs_ret_' || o.id, o.application_id, 'return', 'received', o.updated_at, o.updated_at, o.updated_by_id
  from "hire_offers" o
 where o.superseded_by_id is null and o.courier_status = 'received_by_staff'
   and not exists (select 1 from hire_courier_shipments s where s.application_id = o.application_id and s.direction = 'return');
insert into "hire_courier_events" ("id","shipment_id","status","event_on","remarks","by_id","at")
select 'hce_' || s.id, s.id, 'received', (s.created_at at time zone 'Asia/Kolkata')::date, 'Carried over from the offer''s courier field', s.created_by_id, s.created_at
  from "hire_courier_shipments" s where s.id like 'hcs_ret_%'
   and not exists (select 1 from hire_courier_events e where e.shipment_id = s.id);

create or replace function hire_courier_events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'hire_courier_events is append-only';
end $$;
drop trigger if exists "hire_courier_events_no_update" on "hire_courier_events";
create trigger "hire_courier_events_no_update" before update or delete on "hire_courier_events" for each row execute function hire_courier_events_append_only();

-- ------------------------------------------------------------- assets
create table if not exists "hire_asset_issues" (
  "id" text primary key,
  "application_id" text not null references "hire_applications"("id"),
  "asset_key" text not null,
  "label" text not null,
  "applicable" boolean default true not null,
  "not_applicable_reason" text,
  "serial" text,
  "issued_on" date,
  "issued_by_id" text references "users"("id"),
  "acknowledged_at" timestamp with time zone,
  "ack_method" text,
  "ack_file_id" text,
  "problem" text,
  "returned_on" date,
  "superseded_by_id" text,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "created_by_id" text,
  "updated_by_id" text,
  constraint "hire_asset_issues_ack" check ("ack_method" is null or "ack_method" in ('in_app','signed_slip'))
);
create index if not exists "hire_asset_issues_app" on "hire_asset_issues" ("application_id");
-- An asset ticked "received" under the old checklist was issued that day.
insert into "hire_asset_issues" ("id","application_id","asset_key","label","applicable","serial","issued_on","issued_by_id","created_at","updated_at","created_by_id")
select 'hai_' || i.id, i.application_id, i.item_key, i.item_key, true, i.serial,
       (coalesce(i.done_at, now()) at time zone 'Asia/Kolkata')::date, i.done_by_id, coalesce(i.done_at, now()), coalesce(i.done_at, now()), i.done_by_id
  from "hire_onboarding_items" i
 where i.kind = 'asset' and i.done
   and not exists (select 1 from hire_asset_issues a where a.application_id = i.application_id and a.asset_key = i.item_key);
-- The label the blueprint gave it, where the blueprint still names it.
update "hire_asset_issues" a set "label" = x.label
  from (
    select ap.id as app_id, e->>'key' as k, e->>'label' as label
      from hire_applications ap join hire_blueprints b on b.id = ap.blueprint_id,
           jsonb_array_elements(b.definition->'onboarding'->'assets') e
  ) x
 where x.app_id = a.application_id and x.k = a.asset_key and a.label = a.asset_key;

-- ----------------------------------------------------------- training
create table if not exists "training_modules" (
  "id" text primary key,
  "key" text not null unique,
  "title" text not null,
  "category" text default 'other' not null,
  "active" boolean default true not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "created_by_id" text,
  "updated_by_id" text
);

create table if not exists "training_module_versions" (
  "id" text primary key,
  "module_id" text not null references "training_modules"("id"),
  "version" integer not null,
  "status" text default 'draft' not null,
  "definition" jsonb not null,
  "published_at" timestamp with time zone,
  "published_by_id" text references "users"("id"),
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "created_by_id" text,
  "updated_by_id" text,
  constraint "training_module_versions_status" check ("status" in ('draft','published','retired'))
);
create unique index if not exists "training_module_versions_key" on "training_module_versions" ("module_id","version");

create table if not exists "training_tracks" (
  "id" text primary key,
  "key" text not null unique,
  "title" text not null,
  "active" boolean default true not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "created_by_id" text,
  "updated_by_id" text
);

create table if not exists "training_track_versions" (
  "id" text primary key,
  "track_id" text not null references "training_tracks"("id"),
  "version" integer not null,
  "status" text default 'draft' not null,
  "definition" jsonb not null,
  "published_at" timestamp with time zone,
  "published_by_id" text references "users"("id"),
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "created_by_id" text,
  "updated_by_id" text,
  constraint "training_track_versions_status" check ("status" in ('draft','published','retired'))
);
create unique index if not exists "training_track_versions_key" on "training_track_versions" ("track_id","version");

create table if not exists "training_enrollments" (
  "id" text primary key,
  "user_id" text not null references "users"("id"),
  "application_id" text references "hire_applications"("id"),
  "track_version_id" text not null references "training_track_versions"("id"),
  "trainer_id" text references "users"("id"),
  "assigned_by_id" text references "users"("id"),
  "assigned_at" timestamp with time zone default now() not null,
  "due_on" date,
  "completed_at" timestamp with time zone,
  "status" text default 'active' not null,
  constraint "training_enrollments_status" check ("status" in ('active','completed','withdrawn'))
);
create index if not exists "training_enrollments_user" on "training_enrollments" ("user_id");
create index if not exists "training_enrollments_app" on "training_enrollments" ("application_id");

create table if not exists "training_events" (
  "id" text primary key,
  "enrollment_id" text not null references "training_enrollments"("id"),
  "module_key" text not null,
  "kind" text not null,
  "seconds" integer,
  "note" text,
  "actor_id" text references "users"("id"),
  "at" timestamp with time zone default now() not null,
  constraint "training_events_kind" check ("kind" in ('studied','retraining_signed_off'))
);
create index if not exists "training_events_enrollment" on "training_events" ("enrollment_id","module_key","at");

create table if not exists "training_attempts" (
  "id" text primary key,
  "enrollment_id" text not null references "training_enrollments"("id"),
  "module_key" text not null,
  "module_version_id" text not null references "training_module_versions"("id"),
  "attempt_no" integer not null,
  "started_at" timestamp with time zone default now() not null,
  "deadline_at" timestamp with time zone,
  "submitted_at" timestamp with time zone,
  "items" jsonb not null,
  "answers" jsonb default '[]'::jsonb not null,
  "total_questions" integer not null,
  "correct_answers" integer,
  "score_percent" double precision,
  "pass_mark" integer not null,
  "result" text,
  "trainer_id" text references "users"("id"),
  constraint "training_attempts_result" check ("result" is null or "result" in ('passed','failed'))
);
create unique index if not exists "training_attempts_no" on "training_attempts" ("enrollment_id","module_key","attempt_no");

create table if not exists "training_attempt_corrections" (
  "id" text primary key,
  "attempt_id" text not null references "training_attempts"("id"),
  "score_percent" double precision not null,
  "result" text not null,
  "reason" text not null,
  "by_id" text not null references "users"("id"),
  "at" timestamp with time zone default now() not null
);

-- PRD §21: a submitted attempt cannot be edited, and no attempt is deleted.
create or replace function training_attempts_locked() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'training_attempts are never deleted';
  end if;
  if old.submitted_at is not null then
    raise exception 'a submitted training attempt cannot be changed — record a correction instead';
  end if;
  return new;
end $$;
drop trigger if exists "training_attempts_lock" on "training_attempts";
create trigger "training_attempts_lock" before update or delete on "training_attempts" for each row execute function training_attempts_locked();

create or replace function training_events_append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
drop trigger if exists "training_events_no_update" on "training_events";
create trigger "training_events_no_update" before update or delete on "training_events" for each row execute function training_events_append_only();
drop trigger if exists "training_attempt_corrections_no_update" on "training_attempt_corrections";
create trigger "training_attempt_corrections_no_update" before update or delete on "training_attempt_corrections" for each row execute function training_events_append_only();
