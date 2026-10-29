-- CUSTOMER ORDER TRACKING: one link per order, from confirmation to delivery.
--
-- `erp_order_tracking` is the link (a token per order, a second one for a
-- delivery party that is not the billing party, revoked rather than deleted).
-- `erp_order_milestones` is every step the customer is shown, append-only,
-- one LIVE row per order per step; a step that stops being true is withdrawn.
-- `erp_order_holds` is an order on hold or a delivery delayed, with the
-- customer's sentence and the internal note kept apart.
--
-- Additive and idempotent. Nothing is backfilled here: `npm run jobs --
-- order-tracking-backfill` (and the hourly pass) writes links and steps for
-- orders already in flight, marked backfilled, and sends nobody anything.
CREATE TABLE IF NOT EXISTS "erp_order_tracking" (
  "id" text PRIMARY KEY NOT NULL,
  "order_no" integer NOT NULL,
  "token" text NOT NULL,
  "delivery_token" text,
  "backfilled" boolean DEFAULT false NOT NULL,
  "legacy_links" boolean DEFAULT true NOT NULL,
  "opens" integer DEFAULT 0 NOT NULL,
  "last_opened_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_order_tracking_token_key" ON "erp_order_tracking" ("token");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_order_tracking_delivery_token_key" ON "erp_order_tracking" ("delivery_token");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_order_tracking_live_key" ON "erp_order_tracking" ("order_no") WHERE "revoked_at" is null;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_order_milestones" (
  "id" text PRIMARY KEY NOT NULL,
  "order_no" integer NOT NULL,
  "step" text NOT NULL,
  "at" timestamp with time zone NOT NULL,
  "by_id" text REFERENCES "users"("id"),
  "note" text,
  "backfilled" boolean DEFAULT false NOT NULL,
  "withdrawn_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_order_milestones_order_idx" ON "erp_order_milestones" ("order_no", "at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_order_milestones_live_key" ON "erp_order_milestones" ("order_no", "step") WHERE "withdrawn_at" is null;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_order_holds" (
  "id" text PRIMARY KEY NOT NULL,
  "order_no" integer NOT NULL,
  "kind" text NOT NULL,
  "reason" text NOT NULL,
  "customer_text" text NOT NULL,
  "internal_note" text,
  "next_update_on" date,
  "revised_delivery_on" date,
  "transport_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "line_statuses" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "raised_at" timestamp with time zone DEFAULT now() NOT NULL,
  "raised_by_id" text REFERENCES "users"("id"),
  "resolved_at" timestamp with time zone,
  "resolved_by_id" text REFERENCES "users"("id"),
  "resolution_text" text,
  CONSTRAINT "erp_order_holds_kind_check" CHECK ("kind" in ('hold', 'delay'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_order_holds_order_idx" ON "erp_order_holds" ("order_no", "raised_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_order_holds_open_key" ON "erp_order_holds" ("order_no") WHERE "resolved_at" is null;
--> statement-breakpoint
-- "Out for Delivery": the goods are on the local vehicle to the party's door, a
-- stage Logistics may now record (and the customer sees only when it is).
ALTER TABLE "erp_transports" DROP CONSTRAINT IF EXISTS "erp_transports_stage_check";
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD CONSTRAINT "erp_transports_stage_check"
  CHECK ("material_stage" in ('Dispatched', 'At transport', 'In Transit', 'On the way to Destination area', 'Reached Destination Area', 'Out for Delivery', 'Close - Received to Party'));
--> statement-breakpoint
ALTER TABLE "erp_transport_messages" ADD COLUMN IF NOT EXISTS "order_no" integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_transport_messages_order_idx" ON "erp_transport_messages" ("order_no") WHERE "order_no" is not null;
--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE IF NOT EXISTS 'erp_invoice';
