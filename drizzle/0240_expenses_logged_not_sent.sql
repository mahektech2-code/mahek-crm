-- Expenses are logged one by one and allowances are automatic; nothing waits
-- for a day to be closed any more. See lib/services/expense-submit-service.ts.
--
-- 1. A ₹0 allowance line is never written now, because on every screen it
--    reads as money withheld. The old day-close wrote one for every trip it
--    could not price; they go.
DELETE FROM mbos_expenses
 WHERE coalesce(source_type, 'manual') IN ('travel_leg', 'expense_day')
   AND amount_paise <= 0;
--> statement-breakpoint
-- 2. A day is no longer decided, so a day still WAITING to be decided is a
--    question nobody will be asked again. Only pending ones go: an approved or
--    refused day is a record of somebody's decision and stays. Every expense
--    he logged carries its own approval and is untouched by this.
DELETE FROM mbos_approvals
 WHERE subject_type = 'mbos_expense_days'
   AND state = 'pending';
