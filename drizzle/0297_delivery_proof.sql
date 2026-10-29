-- DELIVERY PROOF: an LR for a transporter, a customer-signed copy for a Mahek
-- Vehicle. A signed copy is an `erp_lrs` row of kind 'signed_copy', so it is
-- uploaded, read, duplicate-checked, voided and attached by the same machinery.
-- "Mahek Vehicle" is a reserved transporter, so every place that carries a
-- transporter by name (orders, bills, loading, trips) carries it unchanged.
ALTER TABLE "erp_lrs" ADD COLUMN "kind" text DEFAULT 'lr' NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_lrs" ADD CONSTRAINT "erp_lrs_kind_check" CHECK ("kind" in ('lr', 'signed_copy'));
--> statement-breakpoint
ALTER TABLE "erp_lrs" ADD COLUMN "read_lr_no" text;
--> statement-breakpoint
ALTER TABLE "erp_lrs" ADD COLUMN "read_kind" text;
--> statement-breakpoint
ALTER TABLE "erp_lrs" ADD COLUMN "read_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_lrs" ADD COLUMN "bill_hint" text;
--> statement-breakpoint
ALTER TABLE "erp_lrs" ADD COLUMN "party_hint" text;
--> statement-breakpoint
ALTER TABLE "erp_lrs" ADD COLUMN "received_by" text;
--> statement-breakpoint
ALTER TABLE "erp_lrs" ADD COLUMN "delivered_on" date;
--> statement-breakpoint
ALTER TABLE "erp_lrs" ADD COLUMN "dup_cleared_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_lrs" ADD COLUMN "dup_cleared_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
CREATE INDEX "erp_lrs_kind_status_idx" ON "erp_lrs" ("kind", "status");
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN "signed_copy_id" text;
--> statement-breakpoint
INSERT INTO "erp_transporters" ("id", "name", "active") VALUES ('etrp_mahek_vehicle', 'Mahek Vehicle', true) ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "erp_transporters" SET "active" = true WHERE lower("name") = 'mahek vehicle';
