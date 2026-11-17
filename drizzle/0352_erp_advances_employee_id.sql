-- WHO HOLDS AN ADVANCE, by id. `employee_name` stays as what was typed on the
-- day (a historical label), but "does this person already hold an open
-- advance" was answered by comparing names — so renaming somebody in HRMS let
-- them be given a second advance while the first was still open, and the
-- "has an open advance" flag vanished from the picker.
ALTER TABLE "erp_advances" ADD COLUMN IF NOT EXISTS "employee_id" text REFERENCES "employees"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_advances_employee_open_idx" ON "erp_advances" ("employee_id") WHERE "status" = 'open';
--> statement-breakpoint
-- Backfill only where the stored name names exactly ONE employee. A shared or
-- unknown name is left null and keeps being matched the old way.
UPDATE "erp_advances" a
   SET "employee_id" = m.id
  FROM (
    SELECT lower(btrim(e.name)) AS k, min(e.id) AS id
      FROM "employees" e
     GROUP BY lower(btrim(e.name))
    HAVING count(*) = 1
  ) m
 WHERE a."employee_id" IS NULL
   AND lower(btrim(a."employee_name")) = m.k;
