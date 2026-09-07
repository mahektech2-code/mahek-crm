-- ONE LEAD.
--
-- A lead lived in two tables. `customers.kind = 'lead'` is the CRM's — a party
-- the book knows has never ordered — and `mbos_leads` is the handset's, with
-- the rung list the CRM never had. Both were real, both were counted, and
-- `leadsCreatedIn` had to read both and DEDUPLICATE them to answer the owner's
-- simplest question. Two tables for one noun is how the telecaller's list, the
-- manager's dashboard and the salesman's handset came to disagree about what a
-- lead even is.
--
-- There is one now, and it is the `customers` row: a lead IS an account that
-- has never ordered, which is the definition this codebase already used. What
-- `mbos_leads` had that `customers` lacked was never identity — it was the
-- state of WORKING a lead, and that lands here as columns beside the account
-- it describes.
--
-- Conversion stops being a copy. `mbos_leads.converted_customer_id` existed
-- because winning a lead meant writing a second row in a second table and
-- joining the two forever; with one row it is `kind` moving from 'lead' to
-- 'customer', and the history, the calls and the GPS fix come with it because
-- they never moved.
--
-- `mbos_leads` is NOT dropped here. It holds no rows on production and the
-- code stops reading it in the same release, but a table that still exists is
-- a decision that can be reversed on a bad morning, and dropping it buys
-- nothing that waiting a release does not.
--
-- Idempotent throughout, like 0093 and the six before it.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "company_name" text;
--> statement-breakpoint
-- The rung list, verbatim from `mbos_lead_stage` — the enum already exists, so
-- the handset's vocabulary is unchanged and its payloads still validate.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_stage" "mbos_lead_stage";
--> statement-breakpoint
-- What the salesman thinks the account could be worth in a month. Paise, like
-- every other amount here. A POTENTIAL somebody typed, never a measured value,
-- which is why no screen may add it to a real order figure.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_estimated_potential_paise" bigint;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_next_follow_up_date" date;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_notes" text;
--> statement-breakpoint
-- Mandatory when the stage is `lost`: a loss nobody explained teaches nothing.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_lost_reason" text;
--> statement-breakpoint
-- Out of the way, not gone — a filter on every read, never a delete. A cold
-- lead is exactly who a campaign goes back to next year.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_archived" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_archived_at" timestamp with time zone;
--> statement-breakpoint
-- Its own column rather than `last_contact_date`, which is the CRM's derived
-- cache of calls and confirmed WhatsApp. Folding the two would let a nightly
-- recompute of one silently move the staleness clock of the other.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_last_activity_date" date;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_converted_at" timestamp with time zone;
--> statement-breakpoint
-- Every lead that has never been worked starts on the first rung. Only leads:
-- a customer has no stage, and giving one to every account would put the whole
-- book on a funnel it left years ago.
UPDATE "customers" SET "lead_stage" = 'new'
 WHERE "kind" = 'lead' AND "lead_stage" IS NULL;
--> statement-breakpoint
-- Carry across whatever `mbos_leads` holds. Production holds nothing — the
-- table has never had a row — but a developer's machine and the seed do, and a
-- migration that silently dropped them would be a migration nobody could test.
--
-- Matched on the mobile number, which is what the handset's own duplicate
-- check already keys on. An unconverted lead whose number matches no customer
-- becomes one; anything already converted is skipped, because the customer row
-- it points at IS the record now.
INSERT INTO "customers" (
  id, name, company_name, phone, city, area, kind, status, lead_source,
  owner_id, gps_lat, gps_lng, lead_stage, lead_estimated_potential_paise,
  lead_next_follow_up_date, lead_notes, lead_lost_reason, lead_archived,
  lead_archived_at, lead_last_activity_date, created_at, updated_at
)
SELECT
  'cus_' || substr(md5(l.id), 1, 12),
  l.name,
  l.company_name,
  l.mobile,
  coalesce(nullif(btrim(l.city), ''), 'Unknown'),
  l.area,
  'lead',
  'active',
  coalesce(l.source::text, 'mbos'),
  l.assigned_to_user_id,
  l.gps_lat,
  l.gps_lng,
  l.stage,
  l.estimated_potential_paise,
  l.next_follow_up_date,
  l.notes,
  l.lost_reason,
  l.archived,
  l.archived_at,
  l.last_activity_date,
  l.server_created_at,
  now()
FROM "mbos_leads" l
WHERE l.converted_customer_id IS NULL
  AND l.mobile IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "customers" c
     WHERE right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10)
         = right(regexp_replace(l.mobile, '[^0-9]', '', 'g'), 10)
  );
--> statement-breakpoint
-- The handset asks for its own open leads on every pull, and the manager's
-- screen orders by the follow-up date. Both are "this user's unarchived leads,
-- soonest first", which is one index.
CREATE INDEX IF NOT EXISTS "customers_lead_worklist_idx"
  ON "customers" ("owner_id", "lead_archived", "lead_next_follow_up_date")
  WHERE "kind" = 'lead';
