-- The expense policy, as versioned data.
--
-- What this replaces is `mbos.expenses.categoryCapsPaise` in `app_settings`:
-- one current value per category, company-wide, with no version, no effective
-- dates, no grade and no city. That storage cannot answer the client's
-- requirement 6 — "old expenses must always be calculated using the policy
-- applicable on that expense date" — because raising a rate there leaves
-- nowhere for the old rate to still be, and every expense ever claimed
-- silently restates itself.
--
-- Nothing reads these tables yet. This migration creates them and seeds a
-- DRAFT first version carrying exactly what the configuration says today, so
-- that when Phase 1 starts reading them the numbers are already the numbers
-- that were in force. It does not publish it: requirement 4 says a policy is
-- verified by an authorised person before it goes live, and a migration is not
-- a person.
--
-- IF NOT EXISTS throughout: see 0080's own note.

DO $$ BEGIN
  CREATE TYPE expense_policy_status AS ENUM ('draft', 'published', 'superseded', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS expense_policies (
  id text PRIMARY KEY,
  version_no integer NOT NULL,
  title text NOT NULL,
  status expense_policy_status NOT NULL DEFAULT 'draft',
  effective_from date NOT NULL,
  effective_to date,
  source_attachment_id text REFERENCES attachments(id),
  notes text,
  published_at timestamptz,
  published_by_id text REFERENCES users(id),
  superseded_by_policy_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id text REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_id text REFERENCES users(id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS expense_policies_version_key
  ON expense_policies (version_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS expense_policies_effective_idx
  ON expense_policies (status, effective_from);
--> statement-breakpoint

-- Two PUBLISHED versions covering one date is the single invalid state this
-- table can express, and it is the state in which requirement 6 has two
-- answers. It is refused here rather than checked in a service: a rule that
-- lives in a service is a rule the next writer does not know about, and this
-- one is about money nobody could later reconcile.
--
-- Drizzle cannot render an exclusion constraint, so it exists only in this
-- file — the same arrangement the trigram indexes in 0008 and 0013 have, and
-- for the same reason. `[]` is deliberate: effective_to is INCLUSIVE, so a
-- version ending on the 31st and one starting on the 31st overlap. A NULL
-- effective_to is an open end and overlaps everything after it.
DO $$ BEGIN
  ALTER TABLE expense_policies
    ADD CONSTRAINT expense_policies_no_overlap
    EXCLUDE USING gist (daterange(effective_from, effective_to, '[]') WITH &&)
    WHERE (status = 'published');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS expense_policy_rules (
  id text PRIMARY KEY,
  policy_id text NOT NULL REFERENCES expense_policies(id) ON DELETE CASCADE,
  kind text NOT NULL,
  scope_key text NOT NULL DEFAULT '',
  grade text,
  city_class text,
  value_json jsonb NOT NULL,
  sequence integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS expense_policy_rules_policy_idx
  ON expense_policy_rules (policy_id, kind);
--> statement-breakpoint

-- One answer per question. NULLS NOT DISTINCT because grade and city_class are
-- nullable and null MEANS "any" here — without it, two "applies to everybody"
-- rules of one kind would both be storable and the policy would have two
-- answers to one question. The engine breaks that tie deterministically
-- because it also runs on a handset over whatever came down the wire, but
-- there is no reason to let one be stored.
CREATE UNIQUE INDEX IF NOT EXISTS expense_policy_rules_key
  ON expense_policy_rules (policy_id, kind, scope_key, grade, city_class, sequence)
  NULLS NOT DISTINCT;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS expense_grades (
  id text PRIMARY KEY,
  key text NOT NULL,
  label text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_residual boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS expense_grades_key ON expense_grades (key);
--> statement-breakpoint

-- Exactly one residual, the same way the product mix categories have exactly
-- one. Without it an unmapped person falls to nothing and is paid nothing;
-- with two, they are paid whichever the planner returned first.
CREATE UNIQUE INDEX IF NOT EXISTS expense_grades_residual_key
  ON expense_grades ((true)) WHERE is_residual;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS expense_grade_map (
  id text PRIMARY KEY,
  position_normalised text NOT NULL,
  position_raw text,
  grade_id text NOT NULL REFERENCES expense_grades(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by_id text REFERENCES users(id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS expense_grade_map_position_key
  ON expense_grade_map (position_normalised);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS expense_city_classes (
  id text PRIMARY KEY,
  city_normalised text NOT NULL,
  city_raw text,
  city_class text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by_id text REFERENCES users(id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS expense_city_classes_city_key
  ON expense_city_classes (city_normalised);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS expense_city_classes_class_idx
  ON expense_city_classes (city_class);
--> statement-breakpoint

-- The grades, with Sales Executive as the residual.
--
-- Sales Executive rather than a "Unmapped" placeholder on purpose: the
-- residual is what somebody with no mapping is actually PAID on, so it has to
-- be a real, defensible, ordinary answer. A placeholder grade with no rules
-- against it would pay a real person nothing and look like a configuration
-- problem rather than a policy one. Whoever is unmapped is listed on the
-- console screen either way.
INSERT INTO expense_grades (id, key, label, sort_order, is_residual)
VALUES
  ('xgrade_sales_executive', 'sales_executive', 'Sales Executive', 10, true),
  ('xgrade_senior_executive', 'senior_executive', 'Senior Sales Executive', 20, false),
  ('xgrade_asm', 'asm', 'Area Sales Manager', 30, false),
  ('xgrade_manager', 'manager', 'Sales Manager', 40, false)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

-- Version 1, as a DRAFT, carrying exactly what configuration says today.
--
-- Read from `app_settings` rather than written as literals, so a deployment
-- that curated its own caps keeps them — the same discipline 0042 and 0051
-- follow. COALESCE to the registry defaults where the row was never written,
-- which is every deployment that has not touched the settings screen.
--
-- effective_from is 2000-01-01 so that when this is eventually published it
-- covers every expense already in the book. Nothing is published here.
INSERT INTO expense_policies (id, version_no, title, status, effective_from, notes)
VALUES (
  'xpol_v1_from_settings',
  1,
  'Version 1 — as configured before the policy module',
  'draft',
  DATE '2000-01-01',
  'Created by migration 0086 from the mbos.expenses.* settings that were in force. It is a DRAFT: publishing a policy is a decision, and a migration is not a person. Check the figures against the issued document, attach that document, then publish.'
)
ON CONFLICT (version_no) DO NOTHING;
--> statement-breakpoint

-- The four category caps become daily `actuals` limits. They were daily caps
-- and they stay daily caps; nothing is reinterpreted on the way across.
INSERT INTO expense_policy_rules (id, policy_id, kind, scope_key, value_json, sequence)
SELECT
  'xrule_v1_cap_' || c.category,
  'xpol_v1_from_settings',
  'actuals',
  'category:' || c.mapped,
  jsonb_build_object(
    'capPerInstancePaise', NULL,
    'capPerDayPaise', COALESCE(
      (SELECT (value -> c.category)::bigint FROM app_settings
        WHERE key = 'mbos.expenses.categoryCapsPaise'),
      c.fallback
    )
  ),
  0
FROM (VALUES
  ('travel', 'travel', 100000::bigint),
  ('food', 'food', 40000::bigint),
  ('lodging', 'lodging', 250000::bigint),
  ('other', 'other', 50000::bigint)
) AS c(category, mapped, fallback)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- And the bill threshold becomes the proof rule it always was.
INSERT INTO expense_policy_rules (id, policy_id, kind, scope_key, value_json, sequence)
VALUES (
  'xrule_v1_proof',
  'xpol_v1_from_settings',
  'proof_threshold',
  '*',
  jsonb_build_object(
    'atPaise',
    COALESCE(
      (SELECT (value #>> '{}')::bigint FROM app_settings
        WHERE key = 'mbos.expenses.billPhotoThresholdPaise'),
      20000
    )
  ),
  0
)
ON CONFLICT DO NOTHING;
