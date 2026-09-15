-- The complaint vocabulary the business actually uses, and a priority on it.
--
-- Three changes, and only the first two touch the database's own types:
--
--   1. `wrong_product` joins `complaint_category`. It is the one heading in the
--      new list of ten with nowhere to go — goods arriving that are not the
--      goods ordered is not a quality fault, not a packaging fault and not a
--      shortage. Every other new label maps onto a member that already exists;
--      `lib/complaint-labels.ts` holds both directions.
--
--   2. `critical` joins `severity`, which is the column a complaint's PRIORITY
--      is stored in. Normal, Urgent and Critical are three answers and two
--      values cannot hold three. Normal is `medium` — the value
--      `complaints.defaultSeverity` already ships — so every complaint raised
--      before the field existed keeps exactly the deadline it was given.
--
--   3. The two settings move, and ONLY where nobody has curated them.
--
-- NOTHING HERE USES EITHER NEW ENUM VALUE. Postgres refuses to use a value
-- added to an enum until the adding transaction commits, and drizzle-kit runs
-- every pending migration in ONE transaction — so a statement below casting a
-- string to 'wrong_product' or 'critical' would fail on any database that has
-- not already been through this file. The settings updates are jsonb and text;
-- they never touch the types. See AGENTS.md on adding an app id for the same
-- trap in its original form.
--
-- No complaint row is rewritten. Every value the column holds today is still a
-- member of the type, and re-filing somebody's complaint under a heading they
-- did not choose is not a migration's business.

ALTER TYPE complaint_category ADD VALUE IF NOT EXISTS 'wrong_product';
--> statement-breakpoint

ALTER TYPE severity ADD VALUE IF NOT EXISTS 'critical';
--> statement-breakpoint

-- The categories offered wherever a complaint is raised.
--
-- Matched on the shipped default as well as on `updated_by_id is null`: a team
-- that curated this list has said what they want offered, and replacing it
-- would silently withdraw headings they chose. A deployment still carrying the
-- nine this app shipped with has chosen nothing.
UPDATE app_settings
   SET value = '["Product Quality","Short Quantity","Leakage / Packaging","Wrong Product","Delivery Delay","Price Issue","Billing Issue","Transport Issue","Sales Service","Other"]'::jsonb,
       updated_at = now()
 WHERE key = 'complaints.categories'
   AND updated_by_id IS NULL
   AND value = '["Packaging","Staff","Product","Transport","Rate / Discount","Immediate Payment","Transportation","Product Complaint","Sales Promotion"]'::jsonb;
--> statement-breakpoint

-- Critical needs a deadline of its own, or it is Urgent wearing a longer word.
-- Eight hours is well inside Urgent's twenty-four and is a starting value a
-- manager changes on the Settings screen, not a rule. The other three are
-- restated exactly as they shipped, so this replaces nothing anybody chose.
UPDATE app_settings
   SET value = '{"low":120,"medium":48,"high":24,"critical":8}'::jsonb,
       updated_at = now()
 WHERE key = 'complaints.slaHours'
   AND updated_by_id IS NULL
   AND value = '{"low":120,"medium":48,"high":24}'::jsonb;
--> statement-breakpoint

-- A curated SLA table keeps every hour somebody chose and gains the one key it
-- cannot express. Without this, a team that had tuned their deadlines would
-- have `complaints.slaHours[severity]` read undefined the first time anybody
-- filed a Critical complaint, and the SLA would land at the epoch.
UPDATE app_settings
   SET value = value || '{"critical":8}'::jsonb,
       updated_at = now()
 WHERE key = 'complaints.slaHours'
   AND NOT (value ? 'critical');
