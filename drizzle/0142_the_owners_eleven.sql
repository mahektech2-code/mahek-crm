-- Mahek's answers on the eleven open decisions: the columns five of them need.
--
-- Two enums are created first and USED in the same file. That is safe here and
-- is not the trap this repo has hit before: a value may not be added to an
-- EXISTING enum and used in the same transaction, but a type created from
-- nothing carries no such restriction.
DO $$ BEGIN
  CREATE TYPE "public"."lead_priority" AS ENUM('high', 'medium', 'low');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "public"."lead_qualification_review" AS ENUM('verified', 'incomplete', 'clarification');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- HOW HARD TO PUSH, as against how much it is worth. Deliberately not the
-- existing `customer_potential`, though the three words match: potential is a
-- judgement about the account, this is a judgement about the work. A big shop
-- nobody can reach this quarter is high potential and low priority.
-- The MANAGER sets it, which is why it is a column and not a sort order.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_priority" "lead_priority";

-- WHEN THE FOUR CONVERSION FIGURES WERE LAST STOOD BEHIND.
--
-- The qualification checklist stopped re-asking the monthly requirement, the
-- potential, the product and the competitor, which is what Mahek chose — and he
-- asked for the gap that leaves to be closed. This is not a second copy of
-- those figures and cannot drift from them; it is a date saying somebody looked
-- and said they still hold.
--
-- NOT BACKFILLED, deliberately. A date invented here would assert that somebody
-- checked when nobody did, on exactly the figures it exists to protect.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_figures_confirmed_at" timestamp with time zone;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_figures_confirmed_by_id" text;

-- The sales manager's verdict on the checklist. `incomplete` and
-- `clarification` now BLOCK, which is a reversal: the review used to be
-- recorded and change nothing, so a manager could write "this is not finished"
-- and watch the lead move on anyway. Null is a checklist nobody has reviewed,
-- which does not block — demanding a review nobody was asked for would stop
-- every lead in the book on deploy day.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_qualification_review" "lead_qualification_review";
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_qualification_review_note" text;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_qualification_reviewed_at" timestamp with time zone;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_qualification_reviewed_by_id" text;

-- ON HOLD NOW HAS TO SAY WHEN IT COMES BACK. Parking already demanded a reason;
-- "back after Diwali" is a sentence nobody is watching, so a parked lead stayed
-- parked until somebody happened to scroll past it. A date is a thing a list
-- can be built from.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_hold_resume_date" date;

DO $$ BEGIN
  ALTER TABLE "customers" ADD CONSTRAINT "customers_lead_figures_confirmed_by_id_users_id_fk"
    FOREIGN KEY ("lead_figures_confirmed_by_id") REFERENCES "public"."users"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "customers" ADD CONSTRAINT "customers_lead_qualification_reviewed_by_id_users_id_fk"
    FOREIGN KEY ("lead_qualification_reviewed_by_id") REFERENCES "public"."users"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- A parked lead is worked off its resume date, so the list that finds them has
-- to be cheap. Partial: it costs nothing on the customers that are not parked.
CREATE INDEX IF NOT EXISTS "customers_lead_hold_resume_idx"
  ON "customers" ("lead_hold_resume_date")
  WHERE "lead_stage" = 'on_hold';
