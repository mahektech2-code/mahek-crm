-- Reimbursements handed over to a salesman, against his expense balance.
--
-- Paid against the balance and allocated to lines oldest first on read
-- (lib/engines/expense-ledger.ts), so nothing here names an expense. A wrong
-- entry is voided with a reason, never deleted.
CREATE TABLE IF NOT EXISTS mbos_expense_payouts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paid_on date NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  mode text,
  reference text,
  note text,
  recorded_by_id text REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by_id text REFERENCES users(id),
  void_reason text,
  CHECK (voided_at IS NULL OR void_reason IS NOT NULL)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mbos_expense_payouts_user_idx
  ON mbos_expense_payouts (user_id, paid_on);
