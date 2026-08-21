-- Who the salesperson answers to.
--
-- A THIRD SEAT, not a rename of an existing one. An account already had two
-- managers and they answer two questions — who sells to this customer, and who
-- raises its paperwork. Neither of them answers the one a regional review
-- actually starts from: which line manager's book is this account in. That was
-- being worked out by hand from a salesperson's name, which stops being
-- possible the moment somebody leaves.
--
-- IT DRIVES NOTHING, and that is the point. `ASSIGNED_TO_SQL` does not read
-- it, no queue is dated from it, no target counts against it and no scope
-- narrows by it. So a manager may set it while `customer.reassign` stays
-- accounts' and admin's: moving a sales manager moves no numbers between a
-- manager's own people, which is the conflict that keeps the sales seat out of
-- their hands.
--
-- THE NAME COLUMN IS NOT A CACHE. `sales_person_name` mirrors the customer
-- master and `recompute_sales_people` rebuilds it every night;
-- `sales_manager_person_name` is the seat itself where the person holding it has no
-- MahekOne login, exactly like `back_office_name`. Nothing outside MahekOne
-- states a sales manager, so nothing rebuilds it and nothing overwrites it —
-- which is also why there is no `sales_manager_decided_at` beside it. That
-- mark exists to hold the sheet off; a mark guarding nothing is one somebody
-- later reads as meaning something.
--
-- The enum value is ADDED here and USED by the application at runtime, never
-- by a later migration: Postgres refuses to use a value added to an enum until
-- the transaction that added it commits, and drizzle-kit applies every pending
-- migration in one.
ALTER TYPE "public"."am_role" ADD VALUE IF NOT EXISTS 'sales_manager';--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "sales_manager_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "sales_manager_person_name" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customers" ADD CONSTRAINT "customers_sales_manager_id_users_id_fk"
    FOREIGN KEY ("sales_manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
-- The question this column exists to answer is "everything under Rahul", asked
-- on a book of eleven hundred and on the day he leaves. Both halves of the seat
-- are indexed, because an account whose sales manager has no login is held by
-- the name alone and would otherwise be the one row a transfer scanned for.
CREATE INDEX IF NOT EXISTS "customers_sales_manager_idx" ON "customers" USING btree ("sales_manager_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_sales_manager_name_idx" ON "customers" USING btree ("sales_manager_person_name");
