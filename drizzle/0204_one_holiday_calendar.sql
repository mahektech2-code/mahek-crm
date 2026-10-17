-- ONE HOLIDAY CALENDAR (src/lib/services/holiday-calendar.ts).
--
-- HRMS's calendar is the master and says who a holiday is for; the field
-- calendar is what the handset, the field attendance verdict and the sales
-- forecast read, and it knows nothing of offices or names. From here on every
-- holiday for all employees is a row of both under the same id, and a day
-- entered on the Sales Dashboard is on HRMS's calendar too. This brings the
-- two that already exist into line.
--
-- Safe to re-run: both inserts skip ids that exist, and the HRMS one also
-- skips a date that already has a holiday for the same people.

-- The field calendar's days, on HRMS's: a scope is kept as who it is for.
INSERT INTO "hrms_holidays" ("id", "date", "category", "name", "tagged", "remark", "created_by_name", "created_at", "updated_at", "created_by_id", "updated_by_id")
SELECT m."id", m."on_date", 'Festival', m."name", COALESCE(m."scope", 'All employees'), 'Entered on the Sales Dashboard', 'Sales Dashboard', m."created_at", m."updated_at", m."created_by_id", m."updated_by_id"
  FROM "mbos_holidays" m
 WHERE NOT EXISTS (SELECT 1 FROM "hrms_holidays" h WHERE h."date" = m."on_date" AND h."tagged" = COALESCE(m."scope", 'All employees'))
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- HRMS's holidays for everybody, on the field calendar.
INSERT INTO "mbos_holidays" ("id", "on_date", "name", "scope", "created_at", "updated_at", "created_by_id", "updated_by_id")
SELECT h."id", h."date", h."name", NULL, h."created_at", h."updated_at", h."created_by_id", h."updated_by_id"
  FROM "hrms_holidays" h
 WHERE h."tagged" = 'All employees'
   AND NOT EXISTS (SELECT 1 FROM "mbos_holidays" m WHERE m."on_date" = h."date" AND m."scope" IS NULL)
ON CONFLICT ("id") DO NOTHING;
