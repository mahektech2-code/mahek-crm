-- LEADS THE PHONES NEVER HEARD ABOUT (Nov 2026).
--
-- 1. 0338_one_lead_ladder rewrote `lead_stage` (the legacy words folded onto
--    the one ladder, and every stageless lead given Suspect) WITHOUT moving
--    `customers.updated_at`. The leads channel is a delta on that column, so a
--    phone that had already synced never received the new rungs, nor the leads
--    that had just gained a stage. Every open lead is moved once here; the next
--    pull sends them all. Compared as text and on columns only, so no enum value
--    is named (drizzle-kit applies every pending migration in one transaction).
--
-- 2. Leads that had ALREADY left the leads channel — lost, archived, or a
--    third-party shop — were never tombstoned (only conversion and the trash
--    were), so every phone that held one kept it under Leads at its last rung.
--    One everybody-tombstone each (`user_id` null: a phone that never held it
--    archives nothing). The id is derived from the lead, so re-running inserts
--    nothing twice. Leads in the trash and converted accounts already have
--    their own.
--
-- Both are cheap on a fresh database: there are no leads.
UPDATE "customers"
   SET "updated_at" = now()
 WHERE "kind" = 'lead'
   AND "lead_stage" IS NOT NULL
   AND "deleted_at" IS NULL;
--> statement-breakpoint
INSERT INTO "mbos_deletions" ("id", "entity", "entity_id", "user_id", "at", "reason")
SELECT 'del_0340_' || c."id",
       'leads',
       c."id",
       NULL,
       now(),
       CASE
         WHEN c."lead_stage"::text = 'lost' THEN 'lead_lost'
         WHEN c."lead_archived" THEN 'lead_archived'
         ELSE 'lead_third_party'
       END
  FROM "customers" c
 WHERE c."kind" = 'lead'
   AND c."lead_stage" IS NOT NULL
   AND c."deleted_at" IS NULL
   AND (c."lead_stage"::text = 'lost' OR c."lead_archived" OR coalesce(c."third_party", false))
ON CONFLICT ("id") DO NOTHING;
