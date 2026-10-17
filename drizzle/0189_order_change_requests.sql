-- A change to an order accounts have already approved, asked for rather than
-- made. See `orderChangeRequests` in src/db/schema.ts.
CREATE TYPE "public"."order_change_status" AS ENUM('pending', 'accepted', 'declined');--> statement-breakpoint
CREATE TABLE "order_change_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"requested_by_id" text NOT NULL,
	"line_items" jsonb NOT NULL,
	"total_amount_paise" bigint NOT NULL,
	"previous_line_items" jsonb,
	"previous_total_paise" bigint,
	"note" text NOT NULL,
	"status" "order_change_status" DEFAULT 'pending' NOT NULL,
	"decided_by_id" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "order_change_requests" ADD CONSTRAINT "order_change_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_change_requests" ADD CONSTRAINT "order_change_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_change_requests" ADD CONSTRAINT "order_change_requests_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_change_requests" ADD CONSTRAINT "order_change_requests_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_change_requests_one_pending" ON "order_change_requests" USING btree ("order_id") WHERE "order_change_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "order_change_requests_status_idx" ON "order_change_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "order_change_requests_requester_idx" ON "order_change_requests" USING btree ("requested_by_id","updated_at");
