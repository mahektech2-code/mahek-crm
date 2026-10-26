-- The Order-to-Delivery PRD (v1.2): order verification, the independent
-- invoice check, the dispatch sticker, the vehicle at dispatch, vehicle trips,
-- and the transport payment shared out by dispatched litres.
--
-- Lines and billed lines that already exist were taken before these checks
-- existed. They are marked as having passed them (with nobody named), because
-- holding every order in flight on a check nobody was asked to make would stop
-- the godown on the day this lands.

-- ---------------------------------------------------------------- orders
ALTER TABLE "erp_orders" ADD COLUMN "order_source" text;--> statement-breakpoint
ALTER TABLE "erp_orders" ADD CONSTRAINT "erp_orders_order_source_check" CHECK ("order_source" is null or "order_source" in ('WhatsApp', 'Phone', 'Sales Order', 'Other'));--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN "order_check" text DEFAULT 'Pending' NOT NULL;--> statement-breakpoint
UPDATE "erp_orders" SET "order_check" = 'Verified';--> statement-breakpoint
ALTER TABLE "erp_orders" ADD CONSTRAINT "erp_orders_order_check_check" CHECK ("order_check" in ('Pending', 'Verified', 'Correction'));--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN "order_checked_by_id" text REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN "order_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN "order_check_note" text;--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN "linked_from_order_no" integer;--> statement-breakpoint
ALTER TABLE "erp_orders" ADD COLUMN "invoice_date" date;--> statement-breakpoint
CREATE INDEX "erp_orders_tally_idx" ON "erp_orders" (upper(btrim("tally_bill_no"))) WHERE "tally_bill_no" is not null;--> statement-breakpoint

-- --------------------------------------------------------- billed lines
ALTER TABLE "erp_order_details" ADD COLUMN "invoice_check" text DEFAULT 'Pending' NOT NULL;--> statement-breakpoint
UPDATE "erp_order_details" SET "invoice_check" = 'Approved';--> statement-breakpoint
ALTER TABLE "erp_order_details" ADD CONSTRAINT "erp_order_details_invoice_check_check" CHECK ("invoice_check" in ('Pending', 'Approved', 'Rejected'));--> statement-breakpoint
ALTER TABLE "erp_order_details" ADD COLUMN "invoice_checked_by_id" text REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "erp_order_details" ADD COLUMN "invoice_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "erp_order_details" ADD COLUMN "invoice_check_note" text;--> statement-breakpoint
ALTER TABLE "erp_order_details" ADD COLUMN "stickers_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "erp_order_details" ADD COLUMN "stickers_by_id" text REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "erp_order_details" ADD COLUMN "vehicle_no" text;--> statement-breakpoint
ALTER TABLE "erp_order_details" ADD COLUMN "driver" text;--> statement-breakpoint
ALTER TABLE "erp_order_details" ADD COLUMN "dispatch_remark" text;--> statement-breakpoint

-- ------------------------------------------- the order's check history
CREATE TABLE "erp_order_reviews" (
  "id" text PRIMARY KEY NOT NULL,
  "order_no" integer NOT NULL,
  "kind" text NOT NULL,
  "result" text NOT NULL,
  "note" text,
  "snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "by_id" text REFERENCES "users"("id"),
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_order_reviews_kind_check" CHECK ("kind" in ('order', 'invoice')),
  CONSTRAINT "erp_order_reviews_result_check" CHECK ("result" in ('submitted', 'verified', 'correction', 'approved', 'rejected', 'reset'))
);--> statement-breakpoint
CREATE INDEX "erp_order_reviews_order_idx" ON "erp_order_reviews" ("order_no", "kind", "at");--> statement-breakpoint

-- --------------------------------------------------------------- trips
INSERT INTO "erp_series" ("key", "last") VALUES ('trip', 0) ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
CREATE TABLE "erp_trips" (
  "id" text PRIMARY KEY NOT NULL,
  "trip_no" integer NOT NULL,
  "trip_date" date NOT NULL,
  "vehicle_no" text,
  "driver" text,
  "transporter" text,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id" text REFERENCES "users"("id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "erp_trips_no_key" ON "erp_trips" ("trip_no");--> statement-breakpoint
CREATE INDEX "erp_trips_vehicle_idx" ON "erp_trips" ("trip_date", upper("vehicle_no"));--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN "trip_id" text REFERENCES "erp_trips"("id");--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN "vehicle_no" text;--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN "delivered_by_id" text REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN "delivery_proof" text;--> statement-breakpoint
CREATE INDEX "erp_transports_trip_idx" ON "erp_transports" ("trip_id");--> statement-breakpoint

-- ------------------------------------- the transport payment and its split
CREATE TABLE "erp_transport_payments" (
  "id" text PRIMARY KEY NOT NULL,
  "trip_id" text NOT NULL REFERENCES "erp_trips"("id"),
  "amount_paise" bigint NOT NULL,
  "paid_on" date,
  "paid_to" text,
  "reference" text,
  "scope" text,
  "note" text,
  "status" text DEFAULT 'recorded' NOT NULL,
  "recorded_by_id" text REFERENCES "users"("id"),
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reversed_by_id" text REFERENCES "users"("id"),
  "reversed_at" timestamp with time zone,
  "reverse_reason" text,
  CONSTRAINT "erp_transport_payments_amount_check" CHECK ("amount_paise" > 0),
  CONSTRAINT "erp_transport_payments_status_check" CHECK ("status" in ('recorded', 'allocated', 'reversed'))
);--> statement-breakpoint
CREATE INDEX "erp_transport_payments_trip_idx" ON "erp_transport_payments" ("trip_id");--> statement-breakpoint
CREATE TABLE "erp_transport_allocations" (
  "id" text PRIMARY KEY NOT NULL,
  "payment_id" text NOT NULL REFERENCES "erp_transport_payments"("id"),
  "transport_id" text NOT NULL REFERENCES "erp_transports"("id"),
  "litres" numeric(12, 2) NOT NULL,
  "amount_paise" bigint NOT NULL,
  "reversed" boolean DEFAULT false NOT NULL,
  CONSTRAINT "erp_transport_allocations_litres_check" CHECK ("litres" > 0),
  CONSTRAINT "erp_transport_allocations_amount_check" CHECK ("amount_paise" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "erp_transport_allocations_pair_key" ON "erp_transport_allocations" ("payment_id", "transport_id");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_transport_allocations_live_key" ON "erp_transport_allocations" ("transport_id") WHERE "reversed" = false;
