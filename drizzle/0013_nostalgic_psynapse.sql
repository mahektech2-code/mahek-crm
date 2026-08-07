CREATE TYPE "public"."sku_status" AS ENUM('ok', 'needs_canonical_id', 'held');--> statement-breakpoint
CREATE TYPE "public"."weight_basis" AS ENUM('box', 'can');--> statement-breakpoint
CREATE TABLE "catalogue_exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"external_id" integer NOT NULL,
	"label" text,
	"reason" text NOT NULL,
	"kind" text DEFAULT 'held' NOT NULL,
	"resolved_product_id" text,
	"resolved_at" timestamp with time zone,
	"resolved_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finished_goods" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"brand_id" text NOT NULL,
	"formulation_id" text NOT NULL,
	"millilitres" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"name" text NOT NULL,
	"external_id" integer,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text
);
--> statement-breakpoint
CREATE TABLE "product_brands" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"formulation_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_formulations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "raw_name" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "finished_good_id" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "brand_id" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "formulation_id" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "packing" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "millilitres_per_can" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "cans_per_box" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "packing_cost_paise" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "weight_grams" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "weight_basis" "weight_basis" DEFAULT 'box' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "selling_price_paise" bigint;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "status" "sku_status" DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "external_ids" jsonb;--> statement-breakpoint
ALTER TABLE "catalogue_exceptions" ADD CONSTRAINT "catalogue_exceptions_resolved_product_id_products_id_fk" FOREIGN KEY ("resolved_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finished_goods" ADD CONSTRAINT "finished_goods_brand_id_product_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."product_brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finished_goods" ADD CONSTRAINT "finished_goods_formulation_id_product_formulations_id_fk" FOREIGN KEY ("formulation_id") REFERENCES "public"."product_formulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_aliases" ADD CONSTRAINT "product_aliases_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_brands" ADD CONSTRAINT "product_brands_formulation_id_product_formulations_id_fk" FOREIGN KEY ("formulation_id") REFERENCES "public"."product_formulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalogue_exceptions_external_key" ON "catalogue_exceptions" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finished_goods_slug_key" ON "finished_goods" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "finished_goods_brand_idx" ON "finished_goods" USING btree ("brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_aliases_name_key" ON "product_aliases" USING btree ("name");--> statement-breakpoint
CREATE INDEX "product_aliases_product_idx" ON "product_aliases" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_brands_slug_key" ON "product_brands" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "product_brands_formulation_idx" ON "product_brands" USING btree ("formulation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_formulations_slug_key" ON "product_formulations" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_finished_good_id_finished_goods_id_fk" FOREIGN KEY ("finished_good_id") REFERENCES "public"."finished_goods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_product_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."product_brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_formulation_id_product_formulations_id_fk" FOREIGN KEY ("formulation_id") REFERENCES "public"."product_formulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "products_name_key" ON "products" USING btree ("name") WHERE finished_good_id is not null;--> statement-breakpoint
CREATE INDEX "products_finished_good_idx" ON "products" USING btree ("finished_good_id");--> statement-breakpoint
CREATE INDEX "products_status_idx" ON "products" USING btree ("status");--> statement-breakpoint
-- Search has to reach the formulation and the brand as well as the SKU name:
-- the same liquid sells as Nano, Astar Nano and M5x4 Thinner, and a telecaller
-- typing "M5x4" mid-call must find the Nano SKUs. Drizzle cannot express an
-- operator-class index, so these live here, as in 0008.
CREATE INDEX IF NOT EXISTS product_formulations_name_trgm_idx
  ON product_formulations USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_brands_name_trgm_idx
  ON product_brands USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finished_goods_name_trgm_idx
  ON finished_goods USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_aliases_name_trgm_idx
  ON product_aliases USING gin (name gin_trgm_ops);
