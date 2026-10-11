-- A transporter godown's town is typed again: the place-tree picker listed
-- every city and area in the country. Godowns picked from it keep that town,
-- by name, in the new column.
ALTER TABLE "erp_transporter_godowns" ADD COLUMN IF NOT EXISTS "town" text;
--> statement-breakpoint
UPDATE "erp_transporter_godowns" g
   SET "town" = p."name"
  FROM "places" p
 WHERE p."id" = g."place_id" AND g."town" IS NULL;
