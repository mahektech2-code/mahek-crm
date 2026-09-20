-- §9 — CONFIRM · CORRECT · UNABLE TO VERIFY, and only the middle one fitted.
--
-- This table was written for the manager's validation call, where the only
-- thing worth a row was a figure the shop contradicted. So it demands a call
-- (`validation_id`), a new value and a reason, all three NOT NULL — which is
-- exactly right for that door and makes the other one impossible.
--
-- The other door is the salesman's own second visit. The PRD reuses the same
-- Confirm / Correct / Unable-to-verify row there verbatim, and a check made
-- standing in a shop has NO VALIDATION CALL BEHIND IT — nobody rang anybody.
-- A confirmation has no corrected value either, and neither does a failure to
-- verify.
--
-- ONE TABLE AND NOT TWO, because the question people ask is "when did this
-- figure change, and why" about one shop, and two tables is two places to look
-- and two answers that can disagree. What separates the doors is
-- `validation_id`: null means the field, a value means the call. A second
-- column saying the same thing is a column that can contradict the first.
--
-- WHAT IS NOT RELAXED is the discipline that made the NOT NULLs worth having.
-- A CORRECTION still has to carry both a new value and a reason, now as a
-- CHECK rather than as two column constraints — a correction with no reason is
-- the manager's word against the salesman's with nothing to settle it, which
-- is the argument this table exists to prevent rather than to record.

CREATE TYPE "field_check_verdict" AS ENUM ('confirmed', 'corrected', 'unverified');

-- Every row that exists is a correction from a validation call: it is the only
-- thing the table could hold. The default backfills them and is then dropped,
-- so a later writer has to SAY which verdict it means rather than inheriting
-- the one that happened to be historical.
ALTER TABLE "lead_verification_corrections"
  ADD COLUMN "verdict" "field_check_verdict" NOT NULL DEFAULT 'corrected';
ALTER TABLE "lead_verification_corrections" ALTER COLUMN "verdict" DROP DEFAULT;

ALTER TABLE "lead_verification_corrections" ALTER COLUMN "validation_id" DROP NOT NULL;
ALTER TABLE "lead_verification_corrections" ALTER COLUMN "corrected" DROP NOT NULL;
ALTER TABLE "lead_verification_corrections" ALTER COLUMN "reason" DROP NOT NULL;

ALTER TABLE "lead_verification_corrections"
  ADD CONSTRAINT "lead_verification_corrections_corrected_says_why"
  CHECK (
    "verdict" <> 'corrected'
    OR ("corrected" IS NOT NULL AND "reason" IS NOT NULL)
  );

-- "Which fields did the field itself check, and what came back" — the question
-- the second door exists to answer, and one no existing index serves.
CREATE INDEX IF NOT EXISTS "lead_verification_corrections_verdict_idx"
  ON "lead_verification_corrections" ("verdict", "changed_at" DESC);
