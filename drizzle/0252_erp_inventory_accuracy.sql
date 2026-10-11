-- Inventory Accuracy Control: a purchase requirement is checked against a
-- BLIND physical count before it is bought, a difference beyond the item's
-- tolerance is a red flag that blocks the purchase until it is recounted,
-- investigated and resolved, and stock moves only through an approved
-- adjustment. See "## Inventory Accuracy Control" in AGENTS.md.
CREATE TABLE IF NOT EXISTS "erp_stock_counts" (
  "id" text PRIMARY KEY NOT NULL,
  "count_no" integer NOT NULL,
  "kind" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "raw_material_id" text NOT NULL REFERENCES "erp_raw_materials"("id"),
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "unit" text NOT NULL,
  "requisition_id" text REFERENCES "erp_requisitions"("id"),
  "recount_of_id" text,
  "reason" text NOT NULL,
  "assigned_to_id" text REFERENCES "users"("id"),
  "due_date" date NOT NULL,
  "counted_qty" numeric(14, 3),
  "bin" text,
  "lot_note" text,
  "count_note" text,
  "counted_by_id" text REFERENCES "users"("id"),
  "counted_at" timestamp with time zone,
  "book_qty" numeric(14, 3),
  "pending_in" numeric(14, 3),
  "pending_out" numeric(14, 3),
  "difference" numeric(14, 3),
  "tolerance" numeric(14, 3),
  "ai_causes" jsonb,
  "resolution" text,
  "resolution_note" text,
  "resolved_by_id" text REFERENCES "users"("id"),
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_stock_counts_kind_check" CHECK ("kind" in ('reorder', 'cycle', 'recount', 'event', 'full')),
  CONSTRAINT "erp_stock_counts_status_check" CHECK ("status" in ('open', 'matched', 'flagged', 'recount', 'investigating', 'resolved', 'cancelled')),
  CONSTRAINT "erp_stock_counts_unit_check" CHECK ("unit" in ('Ltr', 'Pcs')),
  CONSTRAINT "erp_stock_counts_resolution_check" CHECK ("resolution" is null or "resolution" in ('book_confirmed', 'missing_entry', 'adjusted', 'cancelled')),
  CONSTRAINT "erp_stock_counts_counted_check" CHECK (("counted_qty" is null) = ("counted_at" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_stock_counts_no_key" ON "erp_stock_counts" USING btree ("count_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_stock_counts_status_idx" ON "erp_stock_counts" USING btree ("status", "due_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_stock_counts_item_idx" ON "erp_stock_counts" USING btree ("raw_material_id", "godown_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_stock_counts_requisition_idx" ON "erp_stock_counts" USING btree ("requisition_id");
--> statement-breakpoint
-- One open count per item per godown: two counters sent to the same shelf at
-- once is two answers to one question.
CREATE UNIQUE INDEX IF NOT EXISTS "erp_stock_counts_one_open_key" ON "erp_stock_counts" USING btree ("raw_material_id", "godown_id") WHERE "status" = 'open';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_stock_adjustments" (
  "id" text PRIMARY KEY NOT NULL,
  "count_id" text NOT NULL REFERENCES "erp_stock_counts"("id"),
  "raw_material_id" text NOT NULL REFERENCES "erp_raw_materials"("id"),
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "quantity" numeric(14, 3) NOT NULL,
  "reason_code" text NOT NULL,
  "reason" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "requested_by_id" text REFERENCES "users"("id"),
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_by_id" text REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "decision_note" text,
  "posted" jsonb,
  CONSTRAINT "erp_stock_adjustments_status_check" CHECK ("status" in ('pending', 'approved', 'rejected')),
  CONSTRAINT "erp_stock_adjustments_reason_check" CHECK ("reason_code" in ('damage', 'spillage', 'evaporation', 'theft', 'unrecorded_issue', 'unrecorded_receipt', 'measurement', 'other')),
  CONSTRAINT "erp_stock_adjustments_qty_check" CHECK ("quantity" <> 0),
  CONSTRAINT "erp_stock_adjustments_reason_len_check" CHECK (length(trim("reason")) >= 10)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_stock_adjustments_one_pending_key" ON "erp_stock_adjustments" USING btree ("count_id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_stock_adjustments_status_idx" ON "erp_stock_adjustments" USING btree ("status", "requested_at");
--> statement-breakpoint
-- Copied on raise, like the purchase rule: a requirement already in flight
-- when this shipped carries false and is never held back by it.
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "stock_check_required" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "stock_exception_status" text;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "stock_exception_reason" text;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "stock_exception_requested_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "stock_exception_decided_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "stock_exception_decided_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "stock_exception_note" text;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "qty_confirm_note" text;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "qty_confirmed_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD COLUMN IF NOT EXISTS "qty_confirmed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "erp_requisitions" DROP CONSTRAINT IF EXISTS "erp_requisitions_stock_exception_check";
--> statement-breakpoint
ALTER TABLE "erp_requisitions" ADD CONSTRAINT "erp_requisitions_stock_exception_check"
  CHECK ("stock_exception_status" is null or "stock_exception_status" in ('requested', 'approved', 'rejected'));
--> statement-breakpoint
-- Null: the configured default (erp.stockCheck.tolerancePercent) applies.
ALTER TABLE "erp_raw_materials" ADD COLUMN IF NOT EXISTS "count_tolerance_percent" numeric(6, 2);
--> statement-breakpoint
INSERT INTO "erp_series" ("key", "last") VALUES ('stockCount', 0) ON CONFLICT DO NOTHING;
