-- A transporter's godowns are rows of their own, each in ONE town of the
-- reviewed tree and each with its own people to ring. The cascading
-- state/district/city/area picks of 0253 are carried in as one godown per
-- place, and the transporter's own contact and phones become the first
-- godown's first person. erp_transporter_places is dropped after the copy.
CREATE TABLE IF NOT EXISTS "erp_transporter_godowns" (
  "id" text PRIMARY KEY NOT NULL,
  "transporter_id" text NOT NULL REFERENCES "erp_transporters"("id") ON DELETE CASCADE,
  "label" text,
  "place_id" text REFERENCES "places"("id") ON DELETE SET NULL,
  "address" text,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_transporter_godowns_transporter_idx" ON "erp_transporter_godowns" ("transporter_id", "sort_order");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_transporter_contacts" (
  "id" text PRIMARY KEY NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_transporter_godowns"("id") ON DELETE CASCADE,
  "name" text,
  "role" text,
  "phones" text[] DEFAULT '{}' NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_transporter_contacts_phones_max" CHECK (cardinality("phones") <= 3)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_transporter_contacts_godown_idx" ON "erp_transporter_contacts" ("godown_id", "sort_order");
--> statement-breakpoint
-- One godown per place picked under 0253.
INSERT INTO "erp_transporter_godowns" ("id", "transporter_id", "place_id", "sort_order")
SELECT 'etg_' || md5(tp.transporter_id || ':' || tp.place_id),
       tp.transporter_id, tp.place_id,
       (row_number() OVER (PARTITION BY tp.transporter_id ORDER BY p.name))::int - 1
FROM "erp_transporter_places" tp
JOIN "places" p ON p.id = tp.place_id
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- A transporter with a contact, a phone or a typed address and no godown yet
-- gets one, carrying the typed address.
INSERT INTO "erp_transporter_godowns" ("id", "transporter_id", "address", "sort_order")
SELECT 'etg_' || md5(t.id || ':main'), t.id, nullif(trim(t.address), ''), 0
FROM "erp_transporters" t
WHERE NOT EXISTS (SELECT 1 FROM "erp_transporter_godowns" g WHERE g.transporter_id = t.id)
  AND (coalesce(trim(t.address), '') <> '' OR coalesce(trim(t.phone), '') <> ''
       OR coalesce(trim(t.alt_phone), '') <> '' OR coalesce(trim(t.contact_person), '') <> '')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- The transporter's own contact and phones become the first godown's first person.
INSERT INTO "erp_transporter_contacts" ("id", "godown_id", "name", "phones", "sort_order")
SELECT 'etc_' || md5(g.id || ':first'), g.id, nullif(trim(t.contact_person), ''),
       array_remove(ARRAY[nullif(trim(t.phone), ''), nullif(trim(t.alt_phone), '')], NULL), 0
FROM "erp_transporters" t
JOIN LATERAL (
  SELECT g.id FROM "erp_transporter_godowns" g
   WHERE g.transporter_id = t.id ORDER BY g.sort_order, g.id LIMIT 1
) g ON true
WHERE coalesce(trim(t.phone), '') <> '' OR coalesce(trim(t.alt_phone), '') <> '' OR coalesce(trim(t.contact_person), '') <> ''
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_transporter_places";
