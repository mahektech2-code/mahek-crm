-- The standard policy takes the issued Expense Policy document's figures, and a
-- policy gains the parts a different policy would need to be built from the
-- dashboard alone: its own written guidelines, and a hometown per salesman so
-- "away from his hometown" is something the day can be judged on.

-- Which edition of the shipped figures a row holds. An untouched standard row
-- (updated_by_id is null) below the code's edition is moved onto it on its
-- next read; an edited one is left alone.
ALTER TABLE expense_policy_sets ADD COLUMN IF NOT EXISTS defaults_version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
-- The policy's own written lines — what the rules cannot say (bills with every
-- claim, when advances are paid, who to call). A list of strings.
ALTER TABLE expense_policy_sets ADD COLUMN IF NOT EXISTS guidelines jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE expense_policy_set_revisions ADD COLUMN IF NOT EXISTS guidelines jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
-- The document pays share autos at actuals; the handset had no such mode.
INSERT INTO mbos_travel_modes (id, key, label, sort_order, reimbursement_kind, requires_odometer, requires_ticket, scope)
VALUES ('xmode_share_auto', 'share_auto', 'Share auto', 55, 'actuals', false, false, 'leg')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- Where a salesman lives, for the policy's "away from his hometown". Set on the
-- Admin Console; with no row the day keeps what the handset recorded.
CREATE TABLE IF NOT EXISTS expense_hometowns (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  city text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  set_by_id text REFERENCES users(id)
);
