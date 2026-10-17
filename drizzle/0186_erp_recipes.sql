-- ERP simplification, the gaps phase: a standard recipe per SFG product — how
-- much of each raw material one batch takes. New (Mahek Plus had none): a batch
-- can start from it, and a batch line that used more than it allows is
-- flagged. It never refuses a batch.
CREATE TABLE IF NOT EXISTS "erp_recipes" (
  "id" text PRIMARY KEY NOT NULL,
  "formulation_id" text NOT NULL REFERENCES "product_formulations"("id"),
  "raw_material_id" text NOT NULL REFERENCES "erp_raw_materials"("id"),
  "qty_per_batch" numeric(14, 3) NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text,
  CONSTRAINT "erp_recipes_qty_check" CHECK ("qty_per_batch" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_recipes_key" ON "erp_recipes" ("formulation_id", "raw_material_id");
--> statement-breakpoint

-- Recipes is a new screen, so an account narrowed to certain ERP screens does
-- not hold it. Whoever can open SFG batches — the people who make the batches
-- a recipe describes — is given it; everybody else is left as they were.
INSERT INTO "app_module_access" ("id", "user_id", "app", "module", "granted_by_id")
SELECT 'mod_' || substr(md5(m."user_id" || '|erp.recipes'), 1, 16), m."user_id", m."app", 'erp.recipes', m."granted_by_id"
  FROM "app_module_access" m
 WHERE m."app"::text = 'erp' AND m."module" = 'erp.sfgBatches'
ON CONFLICT DO NOTHING;
