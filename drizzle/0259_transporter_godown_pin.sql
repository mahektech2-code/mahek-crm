-- A transporter godown's place on the map: picked on the map, typed, or read
-- off a device standing in it. Both or neither.
ALTER TABLE "erp_transporter_godowns" ADD COLUMN IF NOT EXISTS "lat" double precision;
--> statement-breakpoint
ALTER TABLE "erp_transporter_godowns" ADD COLUMN IF NOT EXISTS "lng" double precision;
--> statement-breakpoint
ALTER TABLE "erp_transporter_godowns" DROP CONSTRAINT IF EXISTS "erp_transporter_godowns_pin_check";
--> statement-breakpoint
ALTER TABLE "erp_transporter_godowns" ADD CONSTRAINT "erp_transporter_godowns_pin_check" CHECK (("lat" IS NULL) = ("lng" IS NULL));
--> statement-breakpoint
-- A godown is filed at a state and a district now: one saved at a city or an
-- area moves up to its district (or its state, where the tree has no district).
WITH RECURSIVE up AS (
  SELECT g.id AS godown_id, p.id, p.kind, p.parent_id, 0 AS depth
    FROM "erp_transporter_godowns" g JOIN "places" p ON p.id = g.place_id
   WHERE p.kind IN ('city', 'area')
  UNION ALL
  SELECT up.godown_id, p.id, p.kind, p.parent_id, up.depth + 1
    FROM up JOIN "places" p ON p.id = up.parent_id
   WHERE up.kind NOT IN ('district', 'state') AND up.depth < 6
)
UPDATE "erp_transporter_godowns" g
   SET place_id = pick.id
  FROM (SELECT DISTINCT ON (godown_id) godown_id, id FROM up WHERE kind IN ('district', 'state') ORDER BY godown_id, depth) pick
 WHERE g.id = pick.godown_id;
