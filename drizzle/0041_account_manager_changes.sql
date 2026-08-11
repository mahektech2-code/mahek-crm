-- Changing who an account answers to, and keeping the answer.
--
-- Two account managers per account already exist as columns — `sales_am_id`
-- and `back_office_am_id` — and both are the sheet's to state today. What is
-- missing is the ability to change one deliberately and have it SURVIVE:
-- `recomputeSalesPeople()` rewrites the name mirrors from the sheet on every
-- nightly pass, and `project-sheet --reassign` overwrites the ids outright.
--
-- `am_decided_at` is the mark that stops both, and it is the third of its
-- kind: `orders.approved_at` and `bills.payment_decided_at` do exactly this
-- job for a decision accounts made. Null on every existing row, so nothing
-- changes for a book nobody has touched — the sheet stays the author until a
-- person overrules it.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "am_decided_at" timestamp with time zone;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "am_role" AS ENUM ('sales', 'back_office');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- The history, with the reason as a COLUMN rather than a sentence inside a
-- JSON blob. "Which accounts moved when Suresh left, and why" is the question
-- this exists to answer, and `audit_log` can only answer it by grep.
CREATE TABLE IF NOT EXISTS "customer_am_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
	"role" "am_role" NOT NULL,
	-- Both the id and the name: the id is null where the sheet only ever named
	-- somebody with no login, and the name is what keeps the row readable once
	-- the account is gone. A history of unresolvable ids is not a history.
	"from_user_id" text REFERENCES "users"("id"),
	"from_name" text,
	"to_user_id" text REFERENCES "users"("id"),
	"to_name" text,
	"reason_code" text NOT NULL,
	"note" text,
	"changed_by_id" text REFERENCES "users"("id"),
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "customer_am_changes_customer_idx"
  ON "customer_am_changes" USING btree ("customer_id","changed_at");--> statement-breakpoint
-- Everything that moved when one person left.
CREATE INDEX IF NOT EXISTS "customer_am_changes_from_idx"
  ON "customer_am_changes" USING btree ("from_user_id","changed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_am_changes_reason_idx"
  ON "customer_am_changes" USING btree ("reason_code","changed_at");
