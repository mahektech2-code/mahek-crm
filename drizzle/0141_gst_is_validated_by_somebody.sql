-- §11.6 / §4.2 — three facts a lead could not hold.
--
-- GST IS COLLECTED ONCE AND VALIDATED ONCE, BY TWO DIFFERENT PEOPLE. The
-- specification is explicit that the salesman records the number and the back
-- office validates it. Until now the qualification checklist carried a
-- `gst_verified` tick inside `lead_qualification`, writable by anybody holding
-- `lead.work` — which is the salesman himself. The man who typed the number in
-- the shop was also the man certifying it was real.
--
-- A column rather than a tick, because a tick says somebody pressed something
-- and this has to say who and when: it is the answer to "can we invoice this
-- business". The distributor ladder has had exactly this column since it
-- shipped; the shop ladder never got the equivalent.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "gst_verified" boolean DEFAULT false NOT NULL;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "gst_verified_at" timestamp with time zone;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "gst_verified_by_id" text;

DO $$ BEGIN
  ALTER TABLE "customers"
    ADD CONSTRAINT "customers_gst_verified_by_id_users_id_fk"
    FOREIGN KEY ("gst_verified_by_id") REFERENCES "public"."users"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- WHO DECIDES AND WHO ACTUALLY BUYS ARE TWO PEOPLE. On a small shop the same
-- man does both and this stays null; on a fabricator the owner approves the
-- supplier and a storekeeper rings the order in every month, and the
-- storekeeper is who the telecalling desk actually speaks to.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_buyer" text;

-- The customer's own address. `users.email` is a MahekOne account; a shop that
-- asked for its quotation by email had that address written into a note.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "email" text;

-- NOTHING IS BACKFILLED, and that is the point of shipping it false.
--
-- An existing `gst_verified` tick in `lead_qualification` was written by
-- whoever held `lead.work`, which is exactly the self-certification this column
-- exists to end. Reading those ticks forward would carry the problem into the
-- new column wearing its authority, and `gst_verified_by_id` would name the
-- salesman as the validator. Every account starts unvalidated and the back
-- office works the queue; the old ticks stay in the jsonb, unread, as the
-- record of what was claimed before anybody was asked to stand behind it.
