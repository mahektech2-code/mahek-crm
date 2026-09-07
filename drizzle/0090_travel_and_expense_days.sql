-- Travel, the day, and the exceptions a day raises.
--
-- This is the storage for §B, §C, §D, §E, §F, §G, §H and §J of the brief. It
-- is one migration rather than four because the tables reference each other
-- and because migration numbering collides across branches in this repo — the
-- fewer files there are between here and main, the fewer there are to renumber.
--
-- Nothing reads any of it yet.

/* ------------------------------------------------------------ travel modes */

CREATE TABLE IF NOT EXISTS mbos_travel_modes (
  id text PRIMARY KEY,
  key text NOT NULL,
  label text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  reimbursement_kind text NOT NULL,
  requires_odometer boolean NOT NULL DEFAULT false,
  requires_ticket boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS mbos_travel_modes_key ON mbos_travel_modes (key);
--> statement-breakpoint

-- The seven the brief names, plus the two anybody will ask for next.
--
-- A TABLE and not an enum: requirement 3 says an admin changes this without a
-- developer, and Postgres refuses to USE an enum value in the transaction that
-- adds it while drizzle-kit applies every pending migration in one — so an
-- enum here would mean a two-deploy dance every time the client names a mode.
INSERT INTO mbos_travel_modes (id, key, label, sort_order, reimbursement_kind, requires_odometer, requires_ticket)
VALUES
  ('xmode_own_bike',        'own_bike',        'Own bike',           10, 'per_km',  true,  false),
  ('xmode_own_car',         'own_car',         'Own car',            20, 'per_km',  true,  false),
  ('xmode_bus',             'bus',             'Bus',                30, 'actuals', false, true),
  ('xmode_train',           'train',           'Train',              40, 'actuals', false, true),
  ('xmode_auto_local',      'auto_local',      'Auto / local transport', 50, 'actuals', false, false),
  ('xmode_taxi',            'taxi',            'Taxi',               60, 'actuals', false, true),
  ('xmode_company_vehicle', 'company_vehicle', 'Company vehicle',    70, 'zero',    true,  false),
  ('xmode_customer_vehicle','customer_vehicle','Customer''s vehicle', 80, 'zero',    false, false),
  ('xmode_walking',         'walking',         'Walking',            90, 'zero',    false, false)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

/* -------------------------------------------------------------- the day */

CREATE TABLE IF NOT EXISTS mbos_expense_days (
  id text PRIMARY KEY,
  client_created_at timestamptz,
  server_created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_id text,
  device_id text,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  departed_at timestamptz,
  returned_at timestamptz,
  departed_from_hometown boolean NOT NULL DEFAULT true,
  destination_city text,
  destination_city_class text,
  arrived_at_destination_at timestamptz,
  arrival_observed_at timestamptz,
  overnight boolean NOT NULL DEFAULT false,
  stayed_in_hotel boolean NOT NULL DEFAULT false,
  tour_id text REFERENCES mbos_tours(id) ON DELETE SET NULL,
  opening_odometer_km integer,
  closing_odometer_km integer,
  odometer_photo_demanded boolean NOT NULL DEFAULT false,
  policy_id text REFERENCES expense_policies(id),
  resolved_grade text,
  resolved_city_class text,
  submitted_at timestamptz,
  submitted_claimed_paise bigint,
  submitted_eligible_paise bigint,
  locked_at timestamptz,
  reopened_at timestamptz,
  reopened_by_id text REFERENCES users(id),
  reopen_reason text,
  note text
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS mbos_expense_days_user_day_key
  ON mbos_expense_days (user_id, day);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mbos_expense_days_day_idx ON mbos_expense_days (day);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mbos_expense_days_submitted_idx ON mbos_expense_days (submitted_at);
--> statement-breakpoint

/* ------------------------------------------------------------- the legs */

CREATE TABLE IF NOT EXISTS mbos_travel_legs (
  id text PRIMARY KEY,
  client_created_at timestamptz,
  server_created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_id text,
  device_id text,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expense_day_id text REFERENCES mbos_expense_days(id) ON DELETE CASCADE,
  mode_key text NOT NULL,
  from_label text,
  to_label text,
  from_lat double precision,
  from_lng double precision,
  to_lat double precision,
  to_lng double precision,
  started_at timestamptz,
  ended_at timestamptz,
  purpose text,
  customer_id text REFERENCES customers(id) ON DELETE SET NULL,
  visit_id text REFERENCES mbos_visits(id) ON DELETE SET NULL,
  order_id text REFERENCES orders(id) ON DELETE SET NULL,
  gps_metres integer,
  gps_method text,
  gps_fix_count integer,
  gps_coverage_pct integer,
  gps_reason text,
  manual_metres integer,
  manual_reason text,
  odometer_start_km integer,
  odometer_end_km integer,
  odometer_metres integer,
  odometer_photo_id text REFERENCES attachments(id),
  chosen_metres integer,
  chosen_source text,
  variance_bps integer,
  ticket_amount_paise bigint,
  ticket_photo_id text REFERENCES attachments(id),
  ticket_reference text,
  note text
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mbos_travel_legs_user_idx
  ON mbos_travel_legs (user_id, started_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mbos_travel_legs_day_idx ON mbos_travel_legs (expense_day_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mbos_travel_legs_customer_idx ON mbos_travel_legs (customer_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mbos_travel_legs_visit_idx ON mbos_travel_legs (visit_id);
--> statement-breakpoint

/* ------------------------------------------------ the expense line, extended */

-- `amount_paise` stays what it always was: what the salesman CLAIMED. It is
-- not renamed to claimed_paise, because renaming it would touch six readers to
-- change nothing, and the one thing worse than an awkward column name is an
-- awkward column name six queries disagree about.
ALTER TABLE mbos_expenses ADD COLUMN IF NOT EXISTS kind text;
--> statement-breakpoint
ALTER TABLE mbos_expenses ADD COLUMN IF NOT EXISTS source_type text;
--> statement-breakpoint
ALTER TABLE mbos_expenses ADD COLUMN IF NOT EXISTS source_id text;
--> statement-breakpoint
ALTER TABLE mbos_expenses ADD COLUMN IF NOT EXISTS expense_day_id text;
--> statement-breakpoint
ALTER TABLE mbos_expenses ADD COLUMN IF NOT EXISTS eligible_paise bigint;
--> statement-breakpoint
ALTER TABLE mbos_expenses ADD COLUMN IF NOT EXISTS excess_paise bigint;
--> statement-breakpoint
ALTER TABLE mbos_expenses ADD COLUMN IF NOT EXISTS policy_id text;
--> statement-breakpoint
ALTER TABLE mbos_expenses ADD COLUMN IF NOT EXISTS resolved_grade text;
--> statement-breakpoint
ALTER TABLE mbos_expenses ADD COLUMN IF NOT EXISTS resolved_city_class text;
--> statement-breakpoint
ALTER TABLE mbos_expenses ADD COLUMN IF NOT EXISTS exception_reason text;
--> statement-breakpoint
ALTER TABLE mbos_expenses ADD COLUMN IF NOT EXISTS vendor_name text;
--> statement-breakpoint
ALTER TABLE mbos_expenses ADD COLUMN IF NOT EXISTS bill_number text;
--> statement-breakpoint
ALTER TABLE mbos_expenses ADD COLUMN IF NOT EXISTS bill_date date;
--> statement-breakpoint
ALTER TABLE mbos_expenses ADD COLUMN IF NOT EXISTS bill_hash text;
--> statement-breakpoint
ALTER TABLE mbos_expenses ADD COLUMN IF NOT EXISTS superseded_by_id text;
--> statement-breakpoint
ALTER TABLE mbos_expenses ADD COLUMN IF NOT EXISTS supersedes_id text;
--> statement-breakpoint

-- Every row that existed keeps meaning exactly what it meant. The category was
-- already one of travel/food/lodging/other, so `kind` reads across unchanged
-- and `local_transport` is simply a value nothing old carries.
UPDATE mbos_expenses SET kind = category::text WHERE kind IS NULL;
--> statement-breakpoint
UPDATE mbos_expenses SET source_type = 'manual' WHERE source_type IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mbos_expenses_day_idx ON mbos_expenses (expense_day_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mbos_expenses_dup_idx ON mbos_expenses (user_id, bill_number);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE mbos_expenses
    ADD CONSTRAINT mbos_expenses_day_fk
    FOREIGN KEY (expense_day_id) REFERENCES mbos_expense_days(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

/* -------------------------------------------------------- the exceptions */

CREATE TABLE IF NOT EXISTS mbos_expense_exceptions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expense_day_id text REFERENCES mbos_expense_days(id) ON DELETE CASCADE,
  expense_id text REFERENCES mbos_expenses(id) ON DELETE CASCADE,
  travel_leg_id text REFERENCES mbos_travel_legs(id) ON DELETE CASCADE,
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'warn',
  message text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  salesman_reason text,
  raised_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_id text REFERENCES users(id),
  resolution text,
  resolution_note text
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mbos_expense_exceptions_open_idx
  ON mbos_expense_exceptions (resolved_at, severity);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mbos_expense_exceptions_day_idx
  ON mbos_expense_exceptions (expense_day_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mbos_expense_exceptions_user_idx
  ON mbos_expense_exceptions (user_id, raised_at DESC);
--> statement-breakpoint

/* ------------------------------------------------------ the approval chain */

-- Requirement 44. The subject's state stays DERIVED from this table — it is
-- the state of the highest step — so nothing about the existing rule changes.
ALTER TABLE mbos_approvals ADD COLUMN IF NOT EXISTS step_index integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE mbos_approvals ADD COLUMN IF NOT EXISTS route_reason text;
--> statement-breakpoint

-- One row per step per subject. Without it a retried escalation writes a
-- second step 1 and the subject has two answers at the same height.
CREATE UNIQUE INDEX IF NOT EXISTS mbos_approvals_step_key
  ON mbos_approvals (subject_type, subject_id, step_index);
--> statement-breakpoint

/* ------------------------------------------------------- attachment parents */

-- Declared here and USED by later code, never inside a migration: Postgres
-- refuses to use an enum value in the transaction that adds it, and
-- drizzle-kit applies every pending migration in one.
ALTER TYPE attachment_parent ADD VALUE IF NOT EXISTS 'mbos_travel_leg';
--> statement-breakpoint
ALTER TYPE attachment_parent ADD VALUE IF NOT EXISTS 'expense_policy';
