-- DISPATCH STICKERS CARRY A QR. One row per printed sticker: its short random
-- id is the QR and the code printed under it. Loading pairs each sticker with
-- the box it is stuck on; an order printed before this has no rows and loads
-- as it always did.
CREATE TABLE "erp_dispatch_stickers" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL REFERENCES "erp_orders"("id"),
	"order_no" integer NOT NULL,
	"seq" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"unit_id" text REFERENCES "erp_units"("id"),
	"loaded_at" timestamp with time zone,
	"loaded_by_id" text REFERENCES "users"("id"),
	"printed_by_id" text REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "erp_dispatch_stickers_status_check" CHECK ("status" in ('active', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "erp_dispatch_stickers_line_seq_key" ON "erp_dispatch_stickers" ("order_id", "seq");
--> statement-breakpoint
CREATE UNIQUE INDEX "erp_dispatch_stickers_unit_key" ON "erp_dispatch_stickers" ("unit_id") WHERE "unit_id" is not null and "status" = 'active';
--> statement-breakpoint
CREATE INDEX "erp_dispatch_stickers_order_no_idx" ON "erp_dispatch_stickers" ("order_no");
