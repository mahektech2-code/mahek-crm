-- A MIX IS SET ON A FORMULATION, NOT ON A CATEGORY.
--
-- Universal / PU / Nano is too broad to aim a salesman at. The liquid is the
-- thing he actually sells, and nineteen formulations is a list somebody can
-- pick three from — three categories was a list that told them almost nothing.
--
-- NOTHING ALREADY SET IS REWRITTEN. The bands configured against a category go
-- on scoring exactly as they did: a band somebody typed is a decision, and
-- reinterpreting "Universal 40%" as a formulation would be inventing which of
-- the six liquids under it they meant. The same treatment `activity_target` and
-- `collection_target_paise` get — retired in place, never reinterpreted.

-- Shares have to add up, so value whose product names no formulation needs
-- somewhere to go: an unmatched order line, or a SKU nobody has filed yet.
-- At most one row may be the residual, exactly as on `product_categories`.
ALTER TABLE "product_formulations"
  ADD COLUMN "is_residual" boolean DEFAULT false NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX "product_formulations_residual_key"
  ON "product_formulations" ("is_residual") WHERE "is_residual";--> statement-breakpoint

-- "Other", and only if the document has not already given us one by that name.
-- `catalogue-import.ts` never deactivates a formulation missing from the
-- document, so this row is safe from the next import.
INSERT INTO "product_formulations" ("id", "name", "slug", "is_residual")
SELECT 'frm_other', 'Other', 'other', true
 WHERE NOT EXISTS (SELECT 1 FROM "product_formulations" WHERE "is_residual");
--> statement-breakpoint

-- A band is about a category OR a formulation, never both and never neither.
ALTER TABLE "sales_target_categories"
  ALTER COLUMN "category_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_target_categories"
  ADD COLUMN "formulation_id" text REFERENCES "product_formulations"("id");--> statement-breakpoint
ALTER TABLE "sales_target_categories"
  ADD CONSTRAINT "sales_target_categories_one_subject"
  CHECK (("category_id" IS NULL) <> ("formulation_id" IS NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "sales_target_categories_formulation_key"
  ON "sales_target_categories" ("target_id", "formulation_id");--> statement-breakpoint

ALTER TABLE "sales_performance_categories"
  ALTER COLUMN "category_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_performance_categories"
  ADD COLUMN "formulation_id" text REFERENCES "product_formulations"("id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_performance_categories_formulation_key"
  ON "sales_performance_categories" ("performance_id", "formulation_id");
