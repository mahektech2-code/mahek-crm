-- STOCK IS ADJUSTED FROM ITS ROW. Add or Remove on any row of Stock on hand,
-- with a reason; it takes effect on save. Adding posts an inflow entry in the
-- stage's ledger (source_type 'adjustment'); removing writes the quantity off
-- to Item Lost Record as a transfer. This row is the record of who and why.
CREATE TABLE IF NOT EXISTS "erp_manual_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"stage" text NOT NULL,
	"item_id" text NOT NULL,
	"item_name" text NOT NULL,
	"lot" text NOT NULL,
	"godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
	"quantity" numeric(14, 3) NOT NULL,
	"unit" text,
	"stock_before" numeric(14, 3) NOT NULL,
	"reason_code" text NOT NULL,
	"note" text,
	"posted" jsonb,
	"created_by_id" text REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erp_manual_adjustments_stage_check" CHECK ("stage" in ('rm', 'sfg', 'fg', 'pack')),
	CONSTRAINT "erp_manual_adjustments_qty_check" CHECK ("quantity" <> 0),
	CONSTRAINT "erp_manual_adjustments_reason_check" CHECK ("reason_code" in ('damaged', 'leakage', 'lost', 'count', 'missed', 'other')),
	CONSTRAINT "erp_manual_adjustments_other_check" CHECK ("reason_code" <> 'other' or length(trim(coalesce("note", ''))) >= 3)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_manual_adjustments_item_idx" ON "erp_manual_adjustments" USING btree ("stage", "item_id", "created_at");
