-- THE UNITS A QUANTITY MAY BE TYPED IN. Every ERP figure is still stored in
-- one base unit per measure (kg, litres, pieces) because the ledgers add them
-- up; this is the list a person may ENTER one in — a Drum (200 L), a Gram, a
-- Dozen — each saying what it measures and how many base units one of it is.
-- The three base units are built in and cannot be changed or retired.
CREATE TABLE "erp_uoms" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "measure" text NOT NULL,
  "per_base" double precision NOT NULL,
  "built_in" boolean DEFAULT false NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_uoms_measure_check" CHECK ("measure" in ('weight', 'volume', 'count')),
  CONSTRAINT "erp_uoms_per_base_check" CHECK ("per_base" > 0),
  CONSTRAINT "erp_uoms_base_check" CHECK (NOT "built_in" OR ("per_base" = 1 AND "active"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "erp_uoms_name_key" ON "erp_uoms" (lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX "erp_uoms_base_key" ON "erp_uoms" ("measure") WHERE "built_in";
--> statement-breakpoint
INSERT INTO "erp_uoms" ("id", "name", "measure", "per_base", "built_in") VALUES
  ('uom_kg', 'Kg', 'weight', 1, true),
  ('uom_litre', 'Litre', 'volume', 1, true),
  ('uom_pcs', 'Pcs', 'count', 1, true),
  ('uom_gram', 'Gram', 'weight', 0.001, false),
  ('uom_quintal', 'Quintal', 'weight', 100, false),
  ('uom_tonne', 'Tonne', 'weight', 1000, false),
  ('uom_ml', 'Millilitre', 'volume', 0.001, false),
  ('uom_can5', 'Can (5 L)', 'volume', 5, false),
  ('uom_can20', 'Can (20 L)', 'volume', 20, false),
  ('uom_drum200', 'Drum (200 L)', 'volume', 200, false),
  ('uom_kl', 'Kilolitre', 'volume', 1000, false),
  ('uom_dozen', 'Dozen', 'count', 12, false)
ON CONFLICT DO NOTHING;
