CREATE TYPE "public"."interaction_outcome" AS ENUM('order_taken', 'no_order', 'no_answer', 'payment_promised', 'follow_up', 'not_interested', 'complaint', 'transport_follow_up', 'casual_talk');--> statement-breakpoint
CREATE TYPE "public"."interaction_type" AS ENUM('outbound_call', 'inbound_call', 'order_received');--> statement-breakpoint
ALTER TYPE "public"."source_module" ADD VALUE 'customer_record' BEFORE 'ad_hoc';--> statement-breakpoint
CREATE TABLE "interaction_product_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"interaction_id" text NOT NULL,
	"product_id" text NOT NULL,
	"quantity" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"reason" text NOT NULL,
	"detail" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"pack_size" text,
	"external_code" text,
	"active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quick_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"interaction_type" "interaction_type" NOT NULL,
	"outcome" "interaction_outcome",
	"label" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "complaints" ALTER COLUMN "category" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."complaint_category";--> statement-breakpoint
CREATE TYPE "public"."complaint_category" AS ENUM('product_quality', 'packaging_damage', 'dispatch_delay', 'billing_issue', 'delivery', 'pricing', 'service', 'shortage', 'other');--> statement-breakpoint
--> §9 map the renamed categories before the column is narrowed, or the cast
--> fails on every existing row holding one of them.
UPDATE "complaints" SET "category" = 'billing_issue' WHERE "category" = 'billing';--> statement-breakpoint
UPDATE "complaints" SET "category" = 'packaging_damage' WHERE "category" = 'packaging';--> statement-breakpoint
UPDATE "complaints" SET "category" = 'other'
  WHERE "category" NOT IN ('product_quality','packaging_damage','dispatch_delay',
                           'billing_issue','delivery','pricing','service','shortage','other');--> statement-breakpoint
ALTER TABLE "complaints" ALTER COLUMN "category" SET DATA TYPE "public"."complaint_category" USING "category"::"public"."complaint_category";--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "connection_status" DROP NOT NULL;--> statement-breakpoint
--> §9 migration. The old outcome vocabulary does not overlap the new one, so
--> the values are preserved, mapped, and only then cast. Anything that cannot
--> be mapped cleanly goes to migration_exceptions for a human — never guessed,
--> never discarded.
ALTER TABLE "calls" ADD COLUMN "interaction_type" "interaction_type" DEFAULT 'outbound_call' NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "order_date" date;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "legacy_outcome" "call_outcome";--> statement-breakpoint
UPDATE "calls" SET "legacy_outcome" = "outcome";--> statement-breakpoint

--> The rang/busy/switched-off detail survives as note text, since the
--> connection-status field is retired for new records.
UPDATE "calls" SET "notes" = trim(both ' ' from coalesce("notes", '') || ' [' || "connection_status"::text || ']')
  WHERE "connection_status" IN ('no_answer','busy','switched_off','wrong_number');--> statement-breakpoint

--> A complaint-raising call was the customer telling us something, so it
--> becomes inbound where a complaint is actually linked.
UPDATE "calls" SET "interaction_type" = 'inbound_call'
  WHERE "outcome" = 'complaint_raised' AND "complaint_id" IS NOT NULL;--> statement-breakpoint

--> Follow-ups migrated from the old model have no date, which the new model
--> requires. They are flagged rather than given an invented one.
INSERT INTO "migration_exceptions" ("id", "entity_type", "entity_id", "reason", "detail")
SELECT 'mex_' || substr(md5(random()::text), 1, 12), 'interaction', "id",
       'Migrated to Follow-up but the old model held no follow-up date',
       jsonb_build_object('legacyOutcome', "outcome"::text)
  FROM "calls" WHERE "outcome" IN ('will_order_later','call_back_requested');--> statement-breakpoint

INSERT INTO "migration_exceptions" ("id", "entity_type", "entity_id", "reason", "detail")
SELECT 'mex_' || substr(md5(random()::text), 1, 12), 'interaction', "id",
       'Payment dispute has no equivalent outcome; mapped to No Order for review',
       jsonb_build_object('legacyOutcome', "outcome"::text)
  FROM "calls" WHERE "outcome" = 'payment_dispute';--> statement-breakpoint

ALTER TABLE "calls" ALTER COLUMN "outcome" SET DATA TYPE text;--> statement-breakpoint
UPDATE "calls" SET "outcome" = CASE "outcome"
    WHEN 'order_placed'        THEN 'order_taken'
    WHEN 'will_order_later'    THEN 'follow_up'
    WHEN 'no_requirement_now'  THEN 'no_order'
    WHEN 'payment_promised'    THEN 'payment_promised'
    WHEN 'payment_dispute'     THEN 'no_order'
    WHEN 'complaint_raised'    THEN 'complaint'
    WHEN 'not_reachable'       THEN 'no_answer'
    WHEN 'call_back_requested' THEN 'follow_up'
    WHEN 'refused'             THEN 'not_interested'
    ELSE NULL
  END;--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "outcome" SET DATA TYPE "public"."interaction_outcome" USING "outcome"::"public"."interaction_outcome";--> statement-breakpoint

ALTER TABLE "calls" ADD COLUMN "quick_note_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "queue_position" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "credit_days" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_call_date" date;--> statement-breakpoint
ALTER TABLE "interaction_product_lines" ADD CONSTRAINT "interaction_product_lines_interaction_id_calls_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_product_lines" ADD CONSTRAINT "interaction_product_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interaction_lines_idx" ON "interaction_product_lines" USING btree ("interaction_id");--> statement-breakpoint
CREATE INDEX "products_active_idx" ON "products" USING btree ("active","display_order");--> statement-breakpoint
CREATE INDEX "quick_notes_lookup_idx" ON "quick_notes" USING btree ("interaction_type","outcome","display_order");
--> statement-breakpoint
--> Last CALL is seeded from the log; last CONTACT is left alone, because an
--> unanswered call was never contact.
UPDATE "customers" c SET "last_call_date" = (
  SELECT max(k."started_at")::date FROM "calls" k WHERE k."customer_id" = c."id"
) WHERE EXISTS (SELECT 1 FROM "calls" k WHERE k."customer_id" = c."id");
