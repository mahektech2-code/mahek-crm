-- A SALES MANAGER CHOOSING A LATER STAGE FROM QUALIFICATION.
--
-- `skipped` is a transition kind of its own: the lead was moved past Sample /
-- Trial (and whatever else lies between) because the Sales Manager decided
-- those rungs do not apply, with a reason code. It is not a manager OVERRIDE —
-- nothing was passed while shut — so it must not be counted as one.
-- `skipped_stages` says which rungs were not climbed, and is null on every
-- other kind of move.
--
-- Additive and idempotent. The new enum value is only USED by application code
-- that runs after this migration has committed, never inside it. Nothing is
-- backfilled and no existing transition is rewritten.
ALTER TYPE "lead_transition_kind" ADD VALUE IF NOT EXISTS 'skipped';
--> statement-breakpoint
ALTER TABLE "lead_stage_transitions" ADD COLUMN IF NOT EXISTS "skipped_stages" jsonb;
