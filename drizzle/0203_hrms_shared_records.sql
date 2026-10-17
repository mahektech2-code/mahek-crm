-- HRMS uses the shared record where MahekOne already had one.
--
-- 1. ONE DOCUMENT LIBRARY. HRMS's documents move into the field app's
--    library, which gains the five things HR's documents needed: who in HRMS
--    a document is for, named people, how it opens, a link's address and a
--    description. A document for all employees or field staff with a file is
--    visible to every handset role (an empty role list); a link, or one meant
--    for one office, is kept off the handsets — a handset cannot open a link
--    and does not know which office its holder is in.
ALTER TABLE "mbos_documents" ADD COLUMN IF NOT EXISTS "audience" text;--> statement-breakpoint
ALTER TABLE "mbos_documents" ADD COLUMN IF NOT EXISTS "audience_employee_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mbos_documents" ADD COLUMN IF NOT EXISTS "media" text;--> statement-breakpoint
ALTER TABLE "mbos_documents" ADD COLUMN IF NOT EXISTS "link_url" text;--> statement-breakpoint
ALTER TABLE "mbos_documents" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint

INSERT INTO "mbos_documents" ("id", "server_created_at", "created_by_id", "updated_at", "updated_by_id", "title", "category", "attachment_id", "visible_to_roles", "active", "audience", "audience_employee_ids", "media", "link_url", "description")
SELECT d."id", d."created_at", d."created_by_id", d."updated_at", d."updated_by_id", d."title", 'policy', d."file_attachment_id",
       CASE WHEN d."type" <> 'Link' AND d."file_attachment_id" IS NOT NULL AND d."tagged" IN ('All employees', 'Field staff') THEN '[]'::jsonb ELSE '["hrms"]'::jsonb END,
       true, d."tagged", d."tagged_employee_ids", d."type", d."url", d."description"
  FROM "hrms_documents" d
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

DROP TABLE IF EXISTS "hrms_documents";--> statement-breakpoint

-- 2. ONE READ STATE FOR AN ANNOUNCEMENT. The bell rows an announcement wrote
--    are remembered, so editing or deleting it changes what people were sent
--    and "seen" is the bell's own read mark rather than a second one.
ALTER TABLE "hrms_notifications" ADD COLUMN IF NOT EXISTS "bell_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- 3. ONE FINANCIAL YEAR START. The score and the points kept two dates for one
--    question; the points read the score's now.
DELETE FROM "app_settings" WHERE "key" = 'hrms.performance.pointsFinancialDate';
--> statement-breakpoint

-- 4. ONE SENDER. The Sales Dashboard's "Send a notification" and HRMS's
--    Announcements both write the same log now, so a message to the field
--    team is on record beside a message to the office, with exactly who it
--    went to and the bell's own title.
ALTER TABLE "hrms_notifications" ADD COLUMN IF NOT EXISTS "recipient_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms_notifications" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'hrms' NOT NULL;--> statement-breakpoint
ALTER TABLE "hrms_notifications" ADD COLUMN IF NOT EXISTS "title" text;
