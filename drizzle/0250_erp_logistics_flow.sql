-- The logistics flow: a bill reaches the transporter, its LR is uploaded by
-- dispatch and attached by logistics, the customer is told on WhatsApp at
-- every step, and it closes when the party has it. See "## Logistics" in AGENTS.md.
ALTER TYPE "public"."attachment_parent" ADD VALUE IF NOT EXISTS 'erp_lr';
--> statement-breakpoint
-- "At transport": the transporter's godown has the goods and the LR has not come yet.
ALTER TABLE "erp_transports" DROP CONSTRAINT IF EXISTS "erp_transports_stage_check";
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD CONSTRAINT "erp_transports_stage_check"
  CHECK ("material_stage" in ('Dispatched', 'At transport', 'In Transit', 'On the way to Destination area', 'Reached Destination Area', 'Close - Received to Party'));
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "packages" integer;
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "litres" numeric(12, 2);
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "transport_due_on" date;
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "at_transport_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "lr_id" text;
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "expected_delivery_on" date;
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "delivered_on" date;
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "received_by" text;
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "issue" text;
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "issue_note" text;
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "issue_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "track_token" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_transports_track_token_key" ON "erp_transports" USING btree ("track_token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_transports_lr_idx" ON "erp_transports" USING btree ("lr_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_lrs" (
  "id" text PRIMARY KEY NOT NULL,
  "lr_no" text NOT NULL,
  "lr_date" date,
  "transporter" text,
  "destination" text,
  "packages" integer,
  "weight_kg" numeric(10, 2),
  "freight_paise" bigint,
  "freight_term" text,
  "file_id" text,
  "godown_id" text REFERENCES "erp_godowns"("id"),
  "note" text,
  "status" text DEFAULT 'unassigned' NOT NULL,
  "void_reason" text,
  "uploaded_by_id" text REFERENCES "users"("id"),
  "uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "assigned_by_id" text REFERENCES "users"("id"),
  "assigned_at" timestamp with time zone,
  CONSTRAINT "erp_lrs_status_check" CHECK ("status" in ('unassigned', 'assigned', 'void'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_lrs_number_key" ON "erp_lrs" USING btree (lower(coalesce("transporter", '')), upper("lr_no")) WHERE "status" <> 'void';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_lrs_status_idx" ON "erp_lrs" USING btree ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_transport_events" (
  "id" text PRIMARY KEY NOT NULL,
  "transport_id" text NOT NULL REFERENCES "erp_transports"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "stage" text,
  "note" text,
  "shared" boolean DEFAULT true NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "by_id" text REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_transport_events_transport_idx" ON "erp_transport_events" USING btree ("transport_id", "at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_transport_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL REFERENCES "customers"("id"),
  "transport_ids" text[] NOT NULL,
  "lr_id" text,
  "event_id" text,
  "kind" text NOT NULL,
  "phone" text,
  "body" text NOT NULL,
  "status" text NOT NULL,
  "why" text,
  "provider_ref" text,
  "sent_at" timestamp with time zone,
  "sent_by_id" text REFERENCES "users"("id"),
  "delivered_at" timestamp with time zone,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_transport_messages_status_check" CHECK ("status" in ('sent', 'to_send', 'sent_by_hand', 'failed', 'skipped', 'delivered', 'read'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_transport_messages_status_idx" ON "erp_transport_messages" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_transport_messages_customer_idx" ON "erp_transport_messages" USING btree ("customer_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_transporters" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "phone" text,
  "alt_phone" text,
  "contact_person" text,
  "address" text,
  "tracking_url" text,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id" text REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_transporters_name_key" ON "erp_transporters" USING btree (lower("name"));
--> statement-breakpoint
-- Every transporter name already on a bill or a party, so the directory starts
-- with the names logistics already types.
INSERT INTO "erp_transporters" ("id", "name")
SELECT 'etr_' || substr(md5(lower(n)), 1, 16), min(n)
  FROM (
    SELECT btrim(transporter) AS n FROM erp_transports WHERE coalesce(btrim(transporter), '') <> ''
    UNION ALL
    SELECT btrim(transporter) FROM erp_customer_profiles WHERE coalesce(btrim(transporter), '') <> ''
  ) x
 GROUP BY lower(n)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Every bill already in follow-up gets its tracking link.
UPDATE "erp_transports" SET "track_token" = substr(md5(random()::text || id), 1, 20) WHERE "track_token" IS NULL;
--> statement-breakpoint
-- Boxes and litres each bill left as, read off its lines.
UPDATE "erp_transports" t
   SET "packages" = x.packages, "litres" = x.litres
  FROM (
    SELECT o.order_no,
           sum(CASE WHEN coalesce(pk.box_type, '') LIKE 'Empty Box%' AND coalesce(p.cans_per_box, 0) > 1
                    THEN ceil(o.qty_cans::numeric / p.cans_per_box) ELSE o.qty_cans END)::int AS packages,
           round(sum(o.qty_cans * coalesce(p.millilitres_per_can, 0))::numeric / 1000, 2) AS litres
      FROM erp_orders o
      JOIN products p ON p.id = o.sku_id
      LEFT JOIN erp_product_packing pk ON pk.product_id = p.id
     WHERE o.status <> 'Cancel'
     GROUP BY o.order_no
  ) x
 WHERE x.order_no = t.order_no AND t.packages IS NULL;
