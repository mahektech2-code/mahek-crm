-- A CATALOGUE EDIT SURVIVES THE NEXT DEPLOY.
--
-- Every deploy runs the catalogue import, which compared each SKU, finished
-- good, brand and formulation with the generated seed and wrote the seed back
-- over anything that differed: packing, cans per box, weight, packing cost and
-- where a SKU or finished good is filed. It also found the upper levels by
-- slug, so a level renamed in the Admin Console stopped matching and the import
-- would have created a second one under the old name.
--
-- `edited_at` marks a row a person changed in the console; the import leaves
-- those rows as they are. `former_slugs` keeps the names a level answered to
-- before a rename, so the import still finds it.
ALTER TABLE "product_formulations" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_formulations" ADD COLUMN "former_slugs" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "product_brands" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_brands" ADD COLUMN "former_slugs" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "finished_goods" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "finished_goods" ADD COLUMN "former_slugs" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
-- Rows the console has already edited, read off the audit log, so they are
-- protected from the first deploy after this one rather than from the second.
UPDATE "products" SET "edited_at" = a.at
  FROM (select entity_id, max(at) as at from audit_log where action = 'catalogue.sku' group by entity_id) a
  WHERE a.entity_id = "products"."id";--> statement-breakpoint
UPDATE "product_formulations" SET "edited_at" = a.at
  FROM (select entity_id, max(at) as at from audit_log where action = 'catalogue.formulation' group by entity_id) a
  WHERE a.entity_id = "product_formulations"."id";--> statement-breakpoint
UPDATE "product_brands" SET "edited_at" = a.at
  FROM (select entity_id, max(at) as at from audit_log where action = 'catalogue.brand' group by entity_id) a
  WHERE a.entity_id = "product_brands"."id";--> statement-breakpoint
UPDATE "finished_goods" SET "edited_at" = a.at
  FROM (select entity_id, max(at) as at from audit_log where action = 'catalogue.good' group by entity_id) a
  WHERE a.entity_id = "finished_goods"."id";
