-- §5.2 / §11.7 — a correction is a first-class, attributed record.
--
-- The verification call stores what the office was told beside what the
-- salesman reported, and that rule is unchanged: nothing here writes over a
-- `customers` column. What the call could not say is WHICH field a manager
-- corrected, what it had said before, and why — four fixed `confirmed_*`
-- columns held the value and folded everything else into a free-text note,
-- where a correction becomes a sentence nobody can count.
--
-- One row per field per call. Append-only: a correction recorded wrongly is
-- answered by a further call, never by an edit.
CREATE TABLE IF NOT EXISTS "lead_verification_corrections" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL,
  "validation_id" text NOT NULL,
  "field" text NOT NULL,
  -- Null where the salesman had recorded nothing and the manager is first to
  -- answer. A copy rather than a lookup, because the lead's own column is live.
  "original" text,
  "corrected" text NOT NULL,
  "reason" text NOT NULL,
  "changed_by_id" text,
  -- Readable after the account is gone, exactly as `customer_am_changes` keeps
  -- a name beside its id.
  "changed_by_name" text,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "lead_verification_corrections"
    ADD CONSTRAINT "lead_verification_corrections_customer_id_customers_id_fk"
    FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- The constraint name is SHORTENED by hand rather than left to Postgres.
-- Drizzle's own convention would spell it
-- `lead_verification_corrections_validation_id_mbos_lead_validations_id_fk`,
-- which is 71 characters; Postgres truncates an identifier at 63 and says so
-- in a notice nobody reads. Truncation is deterministic, so it works — until
-- two long names share their first 63 characters, at which point the second
-- collides with the first and the failure names an identifier that appears
-- nowhere in the source.
DO $$ BEGIN
  ALTER TABLE "lead_verification_corrections"
    ADD CONSTRAINT "lead_verif_corrections_validation_id_fk"
    FOREIGN KEY ("validation_id") REFERENCES "public"."mbos_lead_validations"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "lead_verification_corrections"
    ADD CONSTRAINT "lead_verification_corrections_changed_by_id_users_id_fk"
    FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- The record's own Verification Summary card: this lead, newest first.
CREATE INDEX IF NOT EXISTS "lead_verification_corrections_customer_idx"
  ON "lead_verification_corrections" ("customer_id", "changed_at" DESC);
-- "Which fields get corrected most, and on whose leads" — the question the
-- free-text note could not answer.
CREATE INDEX IF NOT EXISTS "lead_verification_corrections_field_idx"
  ON "lead_verification_corrections" ("field", "changed_at" DESC);
CREATE INDEX IF NOT EXISTS "lead_verification_corrections_validation_idx"
  ON "lead_verification_corrections" ("validation_id");
