-- THE GOODS RECEIPT CORRECTS THE PO.
--
-- Weights and counts at the gate never match the PO, and that is how the trade
-- works. The GRN used to refuse anything past the PO plus 5%, and a shortfall
-- left the PO "Partly received" until somebody closed it short by hand. Now
-- whatever arrived is received, and the person making the GRN corrects the PO
-- on the spot with a CORRECTION LINE under the line it corrects: +extra, or
-- -shortfall where nothing more is coming, always at that line's rate. The
-- original line is never edited.
--
-- Additive only: no existing row changes meaning. A PO with no corrections
-- reads exactly as it did.
--
-- `erp.purchase.receiptTolerancePercent` keeps its key and now only decides
-- which corrections are FLAGGED for the purchase desk. Its shipped 5 moves to
-- 10 only where nobody chose it (updated_by_id is null), the rule 0042 follows.

ALTER TABLE "erp_purchase_orders" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE "erp_po_corrections" (
	"id" text PRIMARY KEY NOT NULL,
	"po_id" text NOT NULL,
	"po_line_id" text NOT NULL,
	"kind" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"rate_paise" bigint NOT NULL,
	"gst_bp" integer NOT NULL,
	"inward_id" text,
	"pr_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_id" text,
	"cancel_reason" text,
	"original_rate_paise" bigint,
	"rate_changed_at" timestamp with time zone,
	"rate_changed_by_id" text,
	"rate_change_reason" text,
	CONSTRAINT "erp_po_corrections_kind_check" CHECK ("erp_po_corrections"."kind" in ('extra', 'short')),
	CONSTRAINT "erp_po_corrections_sign_check" CHECK (("erp_po_corrections"."kind" = 'extra' and "erp_po_corrections"."quantity" > 0) or ("erp_po_corrections"."kind" = 'short' and "erp_po_corrections"."quantity" < 0)),
	CONSTRAINT "erp_po_corrections_rate_check" CHECK ("erp_po_corrections"."rate_paise" >= 0 and "erp_po_corrections"."gst_bp" >= 0),
	CONSTRAINT "erp_po_corrections_cancel_check" CHECK (("erp_po_corrections"."cancelled_at" is null) = ("erp_po_corrections"."cancel_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "erp_po_corrections" ADD CONSTRAINT "erp_po_corrections_po_id_erp_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."erp_purchase_orders"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "erp_po_corrections" ADD CONSTRAINT "erp_po_corrections_po_line_id_erp_po_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."erp_po_lines"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "erp_po_corrections" ADD CONSTRAINT "erp_po_corrections_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "erp_po_corrections" ADD CONSTRAINT "erp_po_corrections_cancelled_by_id_users_id_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "erp_po_corrections" ADD CONSTRAINT "erp_po_corrections_rate_changed_by_id_users_id_fk" FOREIGN KEY ("rate_changed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "erp_po_corrections_line_idx" ON "erp_po_corrections" USING btree ("po_line_id");
--> statement-breakpoint
CREATE INDEX "erp_po_corrections_po_idx" ON "erp_po_corrections" USING btree ("po_id");
--> statement-breakpoint
UPDATE "app_settings"
   SET "value" = '10'::jsonb
 WHERE "key" = 'erp.purchase.receiptTolerancePercent'
   AND "updated_by_id" IS NULL
   AND "value" = '5'::jsonb;
