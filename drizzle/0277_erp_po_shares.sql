ALTER TABLE "erp_purchase_orders" ADD COLUMN IF NOT EXISTS "share_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_purchase_orders_share_token_key" ON "erp_purchase_orders" USING btree ("share_token");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_po_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"po_id" text NOT NULL REFERENCES "erp_purchase_orders"("id"),
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"address" text,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"why" text,
	"provider_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text REFERENCES "users"("id"),
	CONSTRAINT "erp_po_shares_channel_check" CHECK ("channel" in ('whatsapp', 'email', 'link')),
	CONSTRAINT "erp_po_shares_status_check" CHECK ("status" in ('sent', 'by_hand', 'failed', 'copied', 'delivered', 'read'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_po_shares_po_idx" ON "erp_po_shares" USING btree ("po_id","created_at");
