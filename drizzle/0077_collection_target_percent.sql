-- Collection is measured against what was ALREADY overdue at the start of
-- the month, never against a rupee figure typed in and never against money
-- that only became due during the month.
--
-- A stored `collection_target_paise` from before this shipped is not
-- reinterpreted as a percentage — a rupee figure and a share of overdue debt
-- are different questions, and guessing which share a stored rupee number
-- meant would be an invention. Those targets simply stop scoring the
-- collection component, the same way any other unset component does; the
-- month it happened in is not re-scored.
ALTER TABLE "sales_targets" DROP COLUMN "collection_target_paise";--> statement-breakpoint
ALTER TABLE "sales_targets" ADD COLUMN "collection_target_bp" integer;
