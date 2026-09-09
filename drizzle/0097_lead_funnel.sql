-- The funnel itself: the columns, the tables and the one deletion.
--
-- 0096 added the rungs and deliberately spent none of them. This is where they
-- are spent, and it is a second file for the reason written at the top of that
-- one.
--
-- WHAT THIS DOES NOT DO IS MOVE A SINGLE EXISTING ROW. `lead_sales_type` is
-- nullable and nothing backfills it: null means a lead raised before any of
-- this existed, and it climbs the original six rungs exactly as it did
-- yesterday. Guessing which of three ladders somebody was on is a decision
-- dressed up as a migration, and the ladder decides which gates a lead has to
-- pass — so a wrong guess does not merely mislabel a record, it blocks the
-- salesman working it.
--
-- Idempotent throughout, like the eight before it.

/* ------------------------------------------------------------ new types */

DO $$ BEGIN
  CREATE TYPE "lead_sales_type" AS ENUM ('direct', 'distributor', 'third_party');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "lead_transition_kind" AS ENUM ('passed', 'overridden', 'reverted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "mbos_sample_state" AS ENUM (
    'requested', 'approved', 'rejected', 'dispatched',
    'received', 'trial_done', 'reviewed', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

/* --------------------------------------------------- the lead's own columns */

ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_sales_type" "lead_sales_type";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_stage_since" date;--> statement-breakpoint

-- §24 — an active lead may not sit with nothing owed by anybody. A date alone
-- is what this had, and a date alone is how a lead sits for six weeks with
-- everyone assuming somebody else is holding it.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_next_action" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_next_action_date" date;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_next_action_owner_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_next_action_outcome" text;--> statement-breakpoint

-- §7 — the Sales Manager as a second working party. Deliberately not
-- `sales_manager_id` beside it: that seat is a reporting line that drives
-- nothing by design, and hanging a worklist off it would quietly make it
-- load-bearing.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_manager_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_manager_assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_verified_by_id" text;--> statement-breakpoint

-- §6 — the eight mandatory answers before a Suspect may become a Prospect.
-- Columns rather than jsonb because every one of them is asked about on a list
-- or in a report: "which leads want Nano", "what is the pipeline worth in
-- litres". The fifty-five yes/no conditions below are jsonb, because those are
-- only ever read as a set.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_monthly_litres" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_competitor" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_required_product_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_decision_maker" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_credit_days_wanted" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_application" text;--> statement-breakpoint

ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_qualification" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint

-- §4 — the Suspect decision once it has been taken. How many visits a suspect
-- has HAD is not stored: it is counted from `mbos_visits`, because a column
-- would drift the first time a visit arrived late from a handset.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_suspect_decided_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_distributor_salesman_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_expected_order_date" date;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_expected_order_value_paise" bigint;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "customers" ADD CONSTRAINT "customers_lead_next_action_owner_id_users_id_fk"
    FOREIGN KEY ("lead_next_action_owner_id") REFERENCES "users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customers" ADD CONSTRAINT "customers_lead_manager_id_users_id_fk"
    FOREIGN KEY ("lead_manager_id") REFERENCES "users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customers" ADD CONSTRAINT "customers_lead_verified_by_id_users_id_fk"
    FOREIGN KEY ("lead_verified_by_id") REFERENCES "users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customers" ADD CONSTRAINT "customers_lead_required_product_id_products_id_fk"
    FOREIGN KEY ("lead_required_product_id") REFERENCES "products"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- The console ages and sorts by these on every list. Partial, because the
-- overwhelming majority of this table is customers, and a lead index that also
-- covered them would be an index of the whole book.
CREATE INDEX IF NOT EXISTS "customers_lead_funnel_idx"
    ON "customers" ("lead_sales_type", "lead_stage", "lead_stage_since")
    WHERE "kind" = 'lead';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_lead_manager_idx"
    ON "customers" ("lead_manager_id", "lead_stage")
    WHERE "lead_manager_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_lead_next_action_idx"
    ON "customers" ("lead_next_action_date")
    WHERE "kind" = 'lead' AND "lead_archived" = false;--> statement-breakpoint

/* ------------------------------------------------------- §5 §25 §26 the moves */

CREATE TABLE IF NOT EXISTS "lead_stage_transitions" (
  "id"                     text PRIMARY KEY NOT NULL,
  "customer_id"            text NOT NULL,
  "from_stage"             "mbos_lead_stage",
  "to_stage"               "mbos_lead_stage" NOT NULL,
  "sales_type"             "lead_sales_type",
  "kind"                   "lead_transition_kind" DEFAULT 'passed' NOT NULL,
  "reason_code"            text,
  "note"                   text,
  "overridden_conditions"  jsonb DEFAULT '[]'::jsonb NOT NULL,
  "actor_id"               text,
  "actor_role"             text,
  "at"                     timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lead_stage_transitions" ADD CONSTRAINT "lead_stage_transitions_customer_id_customers_id_fk"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lead_stage_transitions" ADD CONSTRAINT "lead_stage_transitions_actor_id_users_id_fk"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- `id` is in the sort because several transitions of one lead share a second,
-- and a paged read whose sort has no tiebreaker shows a row on two pages.
CREATE INDEX IF NOT EXISTS "lead_stage_transitions_customer_idx"
    ON "lead_stage_transitions" ("customer_id", "at", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_stage_transitions_stage_idx"
    ON "lead_stage_transitions" ("to_stage", "at");--> statement-breakpoint

/* ------------------------------------------------- §8 the verification call */

CREATE TABLE IF NOT EXISTS "lead_manager_calls" (
  "id"              text PRIMARY KEY NOT NULL,
  "customer_id"     text NOT NULL,
  "manager_id"      text NOT NULL,
  "called_at"       timestamp with time zone DEFAULT now() NOT NULL,
  "verified"        boolean,
  "answers"         jsonb DEFAULT '{}'::jsonb NOT NULL,
  "follow_up_note"  text,
  "created_at"      timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lead_manager_calls" ADD CONSTRAINT "lead_manager_calls_customer_id_customers_id_fk"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lead_manager_calls" ADD CONSTRAINT "lead_manager_calls_manager_id_users_id_fk"
    FOREIGN KEY ("manager_id") REFERENCES "users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_manager_calls_customer_idx"
    ON "lead_manager_calls" ("customer_id", "called_at");--> statement-breakpoint

/* ------------------------------------------- §23 the distributor's own man */

CREATE TABLE IF NOT EXISTS "distributor_salesmen" (
  "id"                       text PRIMARY KEY NOT NULL,
  "distributor_customer_id"  text NOT NULL,
  "name"                     text NOT NULL,
  "mobile"                   text,
  "territory"                text,
  "active"                   boolean DEFAULT true NOT NULL,
  "created_at"               timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id"            text,
  "updated_at"               timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id"            text
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "distributor_salesmen" ADD CONSTRAINT "distributor_salesmen_distributor_customer_id_customers_id_fk"
    FOREIGN KEY ("distributor_customer_id") REFERENCES "customers"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "distributor_salesmen_distributor_idx"
    ON "distributor_salesmen" ("distributor_customer_id", "active");--> statement-breakpoint

ALTER TABLE "customer_distributors" ADD COLUMN IF NOT EXISTS "distributor_salesman_id" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customer_distributors" ADD CONSTRAINT "customer_distributors_distributor_salesman_id_fk"
    FOREIGN KEY ("distributor_salesman_id") REFERENCES "distributor_salesmen"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customers" ADD CONSTRAINT "customers_lead_distributor_salesman_id_fk"
    FOREIGN KEY ("lead_distributor_salesman_id") REFERENCES "distributor_salesmen"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

/* ------------------------------------------- §11 the thirty distributor asks */

CREATE TABLE IF NOT EXISTS "distributor_profiles" (
  "id"                                 text PRIMARY KEY NOT NULL,
  "customer_id"                        text NOT NULL,
  "gst_verified"                       boolean DEFAULT false NOT NULL,
  "pan_number"                         text,
  "pan_verified"                       boolean DEFAULT false NOT NULL,
  "business_address_verified"          boolean DEFAULT false NOT NULL,
  "business_type"                      text,
  "years_in_business"                  integer,
  "decision_maker"                     text,
  "has_dealer_network"                 boolean DEFAULT false NOT NULL,
  "active_dealer_count"                integer,
  "territory_covered"                  text,
  "cities_covered"                     text,
  "sales_team_size"                    integer,
  "delivery_capability"                text,
  "has_warehouse"                      boolean DEFAULT false NOT NULL,
  "storage_capacity_litres"            integer,
  "product_portfolio"                  text,
  "competitor_brands"                  text,
  "monthly_potential_paise"            bigint,
  "initial_order_potential_paise"      bigint,
  "investment_capacity_paise"          bigint,
  "expected_monthly_purchase_paise"    bigint,
  "credit_days_required"               integer,
  "credit_limit_required_paise"        bigint,
  "proposed_territory"                 text,
  "existing_distributor_checked"       boolean DEFAULT false NOT NULL,
  "territory_conflict"                 boolean,
  "territory_conflict_note"            text,
  "exclusivity_requested"              boolean,
  "initial_stock_commitment_paise"     bigint,
  "monthly_purchase_commitment_paise"  bigint,
  "dealer_development_commitment"      text,
  "expected_start_date"                date,
  "special_discount_percent"           integer,
  "agreed_credit_limit_paise"          bigint,
  "exclusivity_granted"                boolean,
  "commercial_terms_note"              text,
  "commercial_terms_agreed_at"         timestamp with time zone,
  "created_at"                         timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id"                      text,
  "updated_at"                         timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id"                      text
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "distributor_profiles" ADD CONSTRAINT "distributor_profiles_customer_id_customers_id_fk"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- One application per candidate. A second is a double-submit, and two rows
-- would let two screens disagree about one answer.
CREATE UNIQUE INDEX IF NOT EXISTS "distributor_profiles_customer_key"
    ON "distributor_profiles" ("customer_id");--> statement-breakpoint

/* --------------------------------------------------- §15 the sample journey */

ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "state" "mbos_sample_state" DEFAULT 'requested' NOT NULL;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "reason_code" text;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "application" text;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "lead_stage_at_request" "mbos_lead_stage";--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "approved_by_id" text;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "dispatched_by_id" text;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "courier_name" text;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "courier_docket" text;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "expected_delivery_date" date;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "received_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "trial_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "reviewed_by_id" text;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "review_chase_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "last_review_chase_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "cancel_reason" text;--> statement-breakpoint

-- Existing samples get the state their own dates already imply, so the new
-- column does not put a sample delivered in March back at `requested` and onto
-- somebody's dispatch list. Read from the most settled fact backwards; the
-- `WHERE state = 'requested'` guard makes a re-run a no-op.
UPDATE "mbos_samples" SET "state" = 'reviewed'
 WHERE "state" = 'requested' AND "trial_outcome" <> 'pending';--> statement-breakpoint
UPDATE "mbos_samples" SET "state" = 'received'
 WHERE "state" = 'requested' AND "delivered_at" IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mbos_samples_state_idx"
    ON "mbos_samples" ("state", "expected_delivery_date");--> statement-breakpoint

/* ------------------------------------------------- §16 what they said of it */

CREATE TABLE IF NOT EXISTS "sample_feedback" (
  "id"                     text PRIMARY KEY NOT NULL,
  "sample_id"              text NOT NULL,
  "customer_id"            text NOT NULL,
  "quality"                text,
  "performance"            text,
  "application"            text,
  "drying"                 text,
  "competitor_comparison"  text,
  "price_feedback"         text,
  "other_comments"         text,
  "recorded_by_id"         text,
  "recorded_at"            timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sample_feedback" ADD CONSTRAINT "sample_feedback_sample_id_mbos_samples_id_fk"
    FOREIGN KEY ("sample_id") REFERENCES "mbos_samples"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sample_feedback" ADD CONSTRAINT "sample_feedback_customer_id_customers_id_fk"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- One review per sample. A second opinion is a second sample.
CREATE UNIQUE INDEX IF NOT EXISTS "sample_feedback_sample_key"
    ON "sample_feedback" ("sample_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sample_feedback_customer_idx"
    ON "sample_feedback" ("customer_id");--> statement-breakpoint

/* ------------------------------------------------------------ the deletion */

-- `mbos_leads` goes, one release after 0094 said it would.
--
-- 0094 moved every column of it onto `customers` and deliberately left the
-- table standing, on the reasoning that a table which still exists is a
-- decision that can be reversed on a bad morning. The release has passed, it
-- holds no rows, nothing reads it — and what it had grown instead was a doc
-- comment above it still describing the two-table world it had stopped being,
-- which is the half that actually does damage: the next person to open the
-- schema reads the prose.
DROP TABLE IF EXISTS "mbos_leads";--> statement-breakpoint
DROP TYPE IF EXISTS "mbos_lead_source";
