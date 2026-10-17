-- The hard-coded standard expense policy's anchor row.
--
-- The policy itself lives in `src/lib/expense-policy-standard.ts` and nowhere
-- else: its rules are NOT copied here, because two copies of one rate are two
-- answers to "what is a kilometre worth". This row exists only so that
-- `mbos_expense_days.policy_id`, which references `expense_policies`, can name
-- it. ARCHIVED, deliberately: a published row would have to fit the
-- one-version-per-date exclusion constraint against whatever a deployment had
-- already published, and nothing reads this row's status any more.
INSERT INTO expense_policies (id, version_no, title, status, effective_from, notes)
VALUES (
  'xpol_standard',
  1000,
  'Mahek standard expense policy',
  'archived',
  DATE '2000-01-01',
  'The hard-coded standard policy. Its rules are in src/lib/expense-policy-standard.ts; this row is only the key expense days are stamped with.'
)
ON CONFLICT DO NOTHING;
