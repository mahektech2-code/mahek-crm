-- "Send back" — returning an appointment for correction WITHOUT deciding it.
--
-- Mahek asked for the specification's own management action to exist: a step
-- goes back to the person who raised it, carrying a note saying what to fix,
-- and the sales stage does not move. That last half is the whole point. A
-- send-back is not a refusal — a refusal ends the application and somebody
-- rings the candidate — and it is not an approval either. It is the reviewer
-- saying "I cannot answer this yet, here is what is missing", which is a thing
-- that happens on most applications and had nowhere to be recorded at all.
--
-- THERE IS NO NEW APPROVAL STATE, and that is deliberate on two counts.
--
-- Semantically, a sent-back row is still PENDING: nobody has decided anything.
-- A fourth state would be the row asserting a decision that was never taken,
-- and every reader of `mbos_approvals.state` — the queue, the "is anything
-- still outstanding" count inside `decideDistributorAppointment`, the record
-- screen's own step cards — would have had to learn about it or quietly get it
-- wrong. The count is the one that would have hurt: a sent-back step read as
-- decided is a step that no longer holds the appointment back, and management
-- could then appoint a distributor whose sales manager had asked for the
-- application to be redone.
--
-- Mechanically, this repo has been bitten by enum changes more than once. A
-- value may not be added to an existing enum and USED in the same transaction,
-- and drizzle-kit applies every pending migration in ONE transaction — so the
-- value would apply cleanly here, be unusable in 0145, and fail only on a
-- database built from scratch. Three columns beside the state cost nothing and
-- fail nowhere.
ALTER TABLE "mbos_approvals" ADD COLUMN IF NOT EXISTS "sent_back_at" timestamp with time zone;
ALTER TABLE "mbos_approvals" ADD COLUMN IF NOT EXISTS "sent_back_by_id" text;

-- The note is what makes the whole feature worth having. "Do it again" with no
-- idea what was wrong is the failure this exists to prevent, so the action
-- refuses a send-back without one; the column is nullable only because every
-- row written before today has no note and inventing one would be a sentence
-- nobody said.
ALTER TABLE "mbos_approvals" ADD COLUMN IF NOT EXISTS "sent_back_note" text;

DO $$ BEGIN
  ALTER TABLE "mbos_approvals" ADD CONSTRAINT "mbos_approvals_sent_back_by_id_users_id_fk"
    FOREIGN KEY ("sent_back_by_id") REFERENCES "public"."users"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
