-- A transporter carries its GST number, and its godowns are places on the
-- reviewed tree rather than a typed town. One company can keep godowns in
-- several states, districts, cities and areas.
ALTER TABLE "erp_transporters" ADD COLUMN IF NOT EXISTS "gstin" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_transporter_places" (
  "transporter_id" text NOT NULL REFERENCES "erp_transporters"("id") ON DELETE CASCADE,
  "place_id" text NOT NULL REFERENCES "places"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_transporter_places_pkey" PRIMARY KEY ("transporter_id", "place_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_transporter_places_place_idx" ON "erp_transporter_places" ("place_id");
--> statement-breakpoint
-- A typed godown ("Bhiwandi") is adopted where it names exactly one city on
-- the tree. Anything else stays as typed and the screen asks for a pick.
INSERT INTO "erp_transporter_places" ("transporter_id", "place_id")
SELECT t.id, (array_agg(p.id))[1]
FROM "erp_transporters" t
JOIN "places" p
  ON p.kind = 'city'
 AND p.key = regexp_replace(lower(coalesce(t.address, '')), '[^a-z0-9]', '', 'g')
WHERE coalesce(trim(t.address), '') <> ''
GROUP BY t.id
HAVING count(*) = 1
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- What a transporter calls its consignment number. The names are a reference
-- list so a new one is added from the form or from Reference lists, no deploy.
ALTER TABLE "erp_transporters" ADD COLUMN IF NOT EXISTS "consignment_label" text;
--> statement-breakpoint
INSERT INTO "erp_ref_values" ("id", "list_key", "value", "sort_order") VALUES
  ('erprv_cn_lr', 'consignmentLabel', 'LR Number', 1),
  ('erprv_cn_cn', 'consignmentLabel', 'CN Number', 2),
  ('erprv_cn_gr', 'consignmentLabel', 'GR Number', 3),
  ('erprv_cn_consignee', 'consignmentLabel', 'Consignee Number', 4),
  ('erprv_cn_gc', 'consignmentLabel', 'G.C Number', 5)
ON CONFLICT DO NOTHING;
