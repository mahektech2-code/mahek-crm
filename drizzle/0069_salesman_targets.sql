-- Salesman targets, and the score they are read against.
--
-- WHY THIS IS NOT `monthly_targets` WITH A DIFFERENT KEY. That table is a
-- target per CUSTOMER: what one account is expected to buy. These are targets
-- per PERSON, and they are asked in five more units than money — litres,
-- product mix, new names, collected rupees and visits made. Neither is
-- derivable from the other and neither replaces the other.
--
-- WHY LITRES ARE MEASURED AT ALL. A price revision moves every rupee figure in
-- the business without one extra can leaving the godown. Measured on revenue
-- alone, the month prices went up 30% is the month everybody's performance
-- improved 30%, and the salesman who actually sold less looks like the salesman
-- who sold more. Volume is the half of the score a price list cannot move, and
-- the divergence between the two is the alert the whole module was built for.
--
-- WHOSE NUMBER IT IS. Credit falls through: the field salesman on the account,
-- and where there is none, the back office person who works it. Exactly one
-- person, never both — see `lib/sales-attribution.ts`, which is the only place
-- that rule is written. `owner_id` is deliberately NOT in that chain: on an
-- imported book it is whoever ran the import, one person on a thousand rows.

CREATE TYPE "public"."sales_target_status" AS ENUM('draft', 'published');
--> statement-breakpoint

-- A group of products a mix target can be set on.
--
-- The brief names four and the catalogue carries nineteen formulations, so a
-- category cannot BE a formulation and must not be four strings typed into a
-- screen. Exactly one row is the residual — "Other" — and it catches every
-- formulation nobody has classified plus every order line whose product name
-- matched nothing. Without a residual the shares would not total 100% and
-- every percentage on every screen would be wrong by an amount nothing named.
CREATE TABLE "product_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_residual" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "product_categories_slug_key" ON "product_categories" USING btree ("slug");--> statement-breakpoint
-- Two residuals would mean unclassified value counted twice and every share
-- overstated, so it is an index rather than a rule in a service.
CREATE UNIQUE INDEX "product_categories_residual_key" ON "product_categories" USING btree ("is_residual") WHERE is_residual;--> statement-breakpoint

-- The classification hangs on the FORMULATION, which is the level at which it
-- is actually true: one liquid sells as Nano, Astar Nano and M5x4 Thinner and
-- all three are the same strategic product. Saying it per brand would mean
-- saying it three times, and the day somebody says it twice and differently is
-- the day the mix percentages stop adding up.
ALTER TABLE "product_formulations" ADD COLUMN "category_id" text;--> statement-breakpoint
ALTER TABLE "product_formulations" ADD CONSTRAINT "product_formulations_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "sales_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"period" text NOT NULL,
	-- Null means NOT ASKED, which is not zero. An unset component is dropped
	-- from the score and its weight shared out among the ones that were set;
	-- zero would be a target nobody can fail, scored at infinity.
	"revenue_target_paise" bigint,
	-- Millilitres, like the catalogue. A drum is 210 litres and a can is 0.5,
	-- so litres cannot be an integer, and litres only on the way to a screen.
	"volume_target_ml" bigint,
	"new_customer_target" integer,
	"collection_target_paise" bigint,
	"activity_target" integer,
	-- A manager builds thirty of these in an afternoon. A salesman watching his
	-- number change four times before lunch stops believing any of them, so
	-- nothing reaches a handset until it is published.
	"status" "sales_target_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_by_id" text
);
--> statement-breakpoint
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_published_by_id_users_id_fk" FOREIGN KEY ("published_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_targets_key" ON "sales_targets" USING btree ("user_id","period");--> statement-breakpoint
CREATE INDEX "sales_targets_period_idx" ON "sales_targets" USING btree ("period","status");--> statement-breakpoint

-- Three numbers rather than one, because not every salesman can be held to
-- exactly 30% Universal: a book selling into furniture and one selling into
-- automotive are different books.
CREATE TABLE "sales_target_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"category_id" text NOT NULL,
	-- Basis points of total value. 3000 is 30%.
	"minimum_bp" integer DEFAULT 0 NOT NULL,
	"target_bp" integer DEFAULT 0 NOT NULL,
	"stretch_bp" integer DEFAULT 0 NOT NULL,
	-- A band that does not increase scores a larger share lower than a smaller
	-- one — invisible until somebody is marked down for selling more of exactly
	-- what they were asked to sell.
	CONSTRAINT "sales_target_categories_band_order" CHECK (minimum_bp <= target_bp and target_bp <= stretch_bp)
);
--> statement-breakpoint
ALTER TABLE "sales_target_categories" ADD CONSTRAINT "sales_target_categories_target_id_sales_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."sales_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_target_categories" ADD CONSTRAINT "sales_target_categories_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_target_categories_key" ON "sales_target_categories" USING btree ("target_id","category_id");--> statement-breakpoint

-- Every change to a PUBLISHED target, and why.
--
-- A table rather than a line in `audit_log` because the question somebody asks
-- in March is "which targets moved for the price revision", and an audit log
-- can only answer that by grep. The reason is a code, so it can be counted.
-- A draft is edited rather than revised: nothing has been promised to anybody
-- yet, and logging every keystroke of target-setting buries the four changes
-- that matter.
CREATE TABLE "sales_target_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"field" text NOT NULL,
	-- Rendered, not raw: "₹13,00,000" reads back in a year, "130000000" does not.
	"old_value" text,
	"new_value" text,
	"reason" text NOT NULL,
	"reason_note" text,
	"changed_by_id" text,
	-- On the row beside the id, like `customer_am_changes`: a history has to
	-- stay readable after the person leaves and their account goes.
	"changed_by_name" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_target_revisions" ADD CONSTRAINT "sales_target_revisions_target_id_sales_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."sales_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_target_revisions" ADD CONSTRAINT "sales_target_revisions_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_target_revisions_target_idx" ON "sales_target_revisions" USING btree ("target_id","changed_at");--> statement-breakpoint

-- The score, as a CACHE. Never hand-edited; rebuilt by
-- `recomputeSalesPerformance()`. It exists because the manager dashboard asks
-- this for thirty people at once and the handset asks it on a 2G connection.
--
-- It is NOT the same kind of column as `calls.next_step_*`, which record what
-- somebody was TOLD on a day and must never be rebuilt. This is a reading of
-- the present, so a rebuild is a correction rather than a destruction.
CREATE TABLE "sales_performance" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"period" text NOT NULL,
	"target_id" text,
	"revenue_target_paise" bigint,
	"revenue_actual_paise" bigint DEFAULT 0 NOT NULL,
	"revenue_achievement_bp" integer,
	"volume_target_ml" bigint,
	"volume_actual_ml" bigint DEFAULT 0 NOT NULL,
	"volume_achievement_bp" integer,
	"mix_achievement_bp" integer,
	"new_customer_target" integer,
	"new_customer_actual" integer DEFAULT 0 NOT NULL,
	"new_customer_achievement_bp" integer,
	"collection_target_paise" bigint,
	"collection_actual_paise" bigint DEFAULT 0 NOT NULL,
	"collection_achievement_bp" integer,
	"activity_target" integer,
	"activity_actual" integer DEFAULT 0 NOT NULL,
	"activity_achievement_bp" integer,
	-- Out of 100, in basis points. 9140 is 91.40.
	"total_score_bp" integer DEFAULT 0 NOT NULL,
	"rating" text,
	-- Which components nobody set a target for, so the screen can say the score
	-- was computed out of five rather than quietly presenting 100 as 65.
	"untargeted" jsonb,
	-- Revenue whose product name resolved to no catalogue SKU. It counts as
	-- revenue in full and can contribute neither litres nor a mix category, so
	-- the screen says "the mix is computed over 94% of the value" instead of
	-- presenting a share that is quietly wrong.
	"unmatched_revenue_paise" bigint DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_performance" ADD CONSTRAINT "sales_performance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_performance" ADD CONSTRAINT "sales_performance_target_id_sales_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."sales_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_performance_key" ON "sales_performance" USING btree ("user_id","period");--> statement-breakpoint
CREATE INDEX "sales_performance_period_idx" ON "sales_performance" USING btree ("period");--> statement-breakpoint

CREATE TABLE "sales_performance_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"performance_id" text NOT NULL,
	"category_id" text NOT NULL,
	"target_bp" integer DEFAULT 0 NOT NULL,
	"minimum_bp" integer DEFAULT 0 NOT NULL,
	"stretch_bp" integer DEFAULT 0 NOT NULL,
	"actual_paise" bigint DEFAULT 0 NOT NULL,
	-- Shown beside the share, never scored: litres are known only for the lines
	-- whose product name matched the catalogue, and the share is known for all
	-- of them.
	"actual_ml" bigint DEFAULT 0 NOT NULL,
	"actual_bp" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"score_bp" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_performance_categories" ADD CONSTRAINT "sales_performance_categories_performance_id_sales_performance_id_fk" FOREIGN KEY ("performance_id") REFERENCES "public"."sales_performance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_performance_categories" ADD CONSTRAINT "sales_performance_categories_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_performance_categories_key" ON "sales_performance_categories" USING btree ("performance_id","category_id");--> statement-breakpoint

-- The four the brief names, seeded so the module has something to measure on
-- the day it lands. They are ROWS, so a manager can add "Epoxy" the day epoxy
-- becomes strategic, and the ids are stable text rather than uuids so this
-- migration is re-runnable and the classification below can name them.
INSERT INTO "product_categories" ("id", "name", "slug", "is_residual", "display_order") VALUES
	('pcat_universal', 'Universal', 'universal', false, 1),
	('pcat_pu', 'PU', 'pu', false, 2),
	('pcat_nano', 'Nano', 'nano', false, 3),
	('pcat_other', 'Other', 'other', true, 99)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- Classify the formulations that exist today, by slug — which is the lowercased
-- alphanumeric name, exactly what `catalogueSlug` produces.
--
-- Nano is one liquid, M5x4, selling under three brand names. PU is three
-- separate formulations that are one strategic line to the business, which is
-- precisely why a category is not a formulation. Everything else is left NULL,
-- which reads as the residual — the safe direction, since the alternative is a
-- product belonging to no category and value vanishing out of the denominator.
UPDATE "product_formulations" SET "category_id" = 'pcat_universal' WHERE "slug" = 'mahekuniversal';--> statement-breakpoint
UPDATE "product_formulations" SET "category_id" = 'pcat_nano' WHERE "slug" = 'm5x4';--> statement-breakpoint
UPDATE "product_formulations" SET "category_id" = 'pcat_pu' WHERE "slug" IN ('puthinnerm16', 'puthinnerm73', 'puthinnernb');
