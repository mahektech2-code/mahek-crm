-- Named expense policies, and who is under which.
--
-- The policy was hard-coded (0228) because the versioned rule builder was too
-- much to use. It is editable again, as NAMED POLICIES rather than dated
-- versions: the standard one everybody is under, plus any number of others a
-- salesman can be put on instead. A policy's rules are one jsonb array of the
-- engine's own `PolicyRule` shape — the editor saves the whole list at once,
-- and the engine reads exactly what was saved.
--
-- The standard policy's ROW is written by the application from the code's
-- defaults the first time it is read (`ensureStandardSet`), not here, so the
-- rates exist in one place: `src/lib/expense-policy-standard.ts`.
CREATE TABLE IF NOT EXISTS expense_policy_sets (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  is_standard boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  revision integer NOT NULL DEFAULT 1,
  cloned_from_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id text REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_id text REFERENCES users(id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS expense_policy_sets_name_key
  ON expense_policy_sets (lower(name));
--> statement-breakpoint

-- One standard policy, held by the index rather than by a service.
CREATE UNIQUE INDEX IF NOT EXISTS expense_policy_sets_one_standard
  ON expense_policy_sets (is_standard) WHERE is_standard;
--> statement-breakpoint

-- Every saved state of a policy, so an edit can be read back and undone.
CREATE TABLE IF NOT EXISTS expense_policy_set_revisions (
  id text PRIMARY KEY,
  set_id text NOT NULL REFERENCES expense_policy_sets(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  name text NOT NULL,
  description text,
  rules jsonb NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id text REFERENCES users(id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS expense_policy_set_revisions_key
  ON expense_policy_set_revisions (set_id, revision);
--> statement-breakpoint

-- One row per person NOT on the standard policy. No row means standard.
CREATE TABLE IF NOT EXISTS expense_policy_assignments (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  set_id text NOT NULL REFERENCES expense_policy_sets(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by_id text REFERENCES users(id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS expense_policy_assignments_set_idx
  ON expense_policy_assignments (set_id);
