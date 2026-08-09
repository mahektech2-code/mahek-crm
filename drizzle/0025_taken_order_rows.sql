-- The Taken Order tab: orders as the team types them, before dispatch.
--
-- Hand-written rather than generated. `0024` added an enum VALUE and carries
-- no snapshot, so drizzle-kit would diff this schema against `0023` and re-emit
-- that ALTER TYPE — which fails on every database that has already run it.
CREATE TABLE "sheet_taken_order_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"sync_id" text NOT NULL,
	"row_number" integer NOT NULL,
	"line_key" text NOT NULL,
	"order_number" text,
	"raw" jsonb NOT NULL,
	"row_hash" text NOT NULL,
	"status" "sheet_row_status" DEFAULT 'present' NOT NULL,
	"last_seen_sync_id" text,
	"order_date" date,
	"location" text,
	"billing_party_name" text,
	"delivery_party_name" text,
	"standing_instructions" text,
	"area" text,
	"transporter_name" text,
	"user_name" text,
	"taken_at" timestamp with time zone,
	"transportation_cost_paise" bigint,
	"remark" text,
	"party_status" text,
	"description" text,
	"cans" integer,
	"boxes" integer,
	"rate_paise" bigint,
	"discount_bp" integer,
	"tally_bill_no" text,
	"weight_grams" bigint,
	"office_status" text,
	"entry_status" text,
	"open" boolean DEFAULT true NOT NULL,
	"matched_customer_id" text,
	"customer_match_status" "sheet_match_status" DEFAULT 'pending' NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sheet_taken_order_rows" ADD CONSTRAINT "sheet_taken_order_rows_sync_id_sheet_sync_runs_id_fk" FOREIGN KEY ("sync_id") REFERENCES "public"."sheet_sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_taken_order_rows" ADD CONSTRAINT "sheet_taken_order_rows_matched_customer_id_customers_id_fk" FOREIGN KEY ("matched_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sheet_taken_order_rows_line_key" ON "sheet_taken_order_rows" USING btree ("line_key");--> statement-breakpoint
CREATE INDEX "sheet_taken_order_rows_sync_idx" ON "sheet_taken_order_rows" USING btree ("sync_id");--> statement-breakpoint
CREATE INDEX "sheet_taken_order_rows_order_idx" ON "sheet_taken_order_rows" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "sheet_taken_order_rows_open_idx" ON "sheet_taken_order_rows" USING btree ("open","billing_party_name");--> statement-breakpoint
CREATE INDEX "sheet_taken_order_rows_customer_idx" ON "sheet_taken_order_rows" USING btree ("matched_customer_id");--> statement-breakpoint
CREATE INDEX "sheet_taken_order_rows_date_idx" ON "sheet_taken_order_rows" USING btree ("order_date","id");
