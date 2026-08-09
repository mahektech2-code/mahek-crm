CREATE TYPE "public"."sheet_match_status" AS ENUM('pending', 'matched', 'ambiguous', 'unmatched');--> statement-breakpoint
CREATE TYPE "public"."sheet_row_status" AS ENUM('present', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."sheet_sync_mode" AS ENUM('append', 'reconcile', 'reparse');--> statement-breakpoint
CREATE TYPE "public"."sheet_sync_status" AS ENUM('running', 'ok', 'failed');--> statement-breakpoint
CREATE TABLE "sheet_order_rows" (
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
	"dispatch_date" date,
	"billing_party_name" text,
	"area" text,
	"transport_name" text,
	"payment_type" text,
	"payment_status" text,
	"payment_received_date" date,
	"segment_counter_type" text,
	"sales_man" text,
	"credit_days" integer,
	"order_fulfill_days" integer,
	"gst_bp" integer,
	"description" text,
	"pack_type" text,
	"cans" integer,
	"volume_ml" bigint,
	"rate_paise" bigint,
	"amount_paise" bigint,
	"final_amount_paise" bigint,
	"discount_bp" integer,
	"tally_bill_no" text,
	"matched_customer_id" text,
	"customer_match_status" "sheet_match_status" DEFAULT 'pending' NOT NULL,
	"matched_product_id" text,
	"product_match_status" "sheet_match_status" DEFAULT 'pending' NOT NULL,
	"match_note" text,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sheet_sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"tab_title" text NOT NULL,
	"mode" "sheet_sync_mode" DEFAULT 'reconcile' NOT NULL,
	"status" "sheet_sync_status" DEFAULT 'running' NOT NULL,
	"rows_read" integer DEFAULT 0 NOT NULL,
	"rows_created" integer DEFAULT 0 NOT NULL,
	"rows_updated" integer DEFAULT 0 NOT NULL,
	"rows_unchanged" integer DEFAULT 0 NOT NULL,
	"rows_withdrawn" integer DEFAULT 0 NOT NULL,
	"rows_with_issues" integer DEFAULT 0 NOT NULL,
	"highest_row" integer DEFAULT 1 NOT NULL,
	"cursor_row" integer,
	"error" text,
	"feeds_crm" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"triggered_by_id" text
);
--> statement-breakpoint
ALTER TABLE "sheet_order_rows" ADD CONSTRAINT "sheet_order_rows_sync_id_sheet_sync_runs_id_fk" FOREIGN KEY ("sync_id") REFERENCES "public"."sheet_sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_order_rows" ADD CONSTRAINT "sheet_order_rows_matched_customer_id_customers_id_fk" FOREIGN KEY ("matched_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_order_rows" ADD CONSTRAINT "sheet_order_rows_matched_product_id_products_id_fk" FOREIGN KEY ("matched_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_sync_runs" ADD CONSTRAINT "sheet_sync_runs_triggered_by_id_users_id_fk" FOREIGN KEY ("triggered_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sheet_order_rows_line_key" ON "sheet_order_rows" USING btree ("line_key");--> statement-breakpoint
CREATE INDEX "sheet_order_rows_sync_idx" ON "sheet_order_rows" USING btree ("sync_id");--> statement-breakpoint
CREATE INDEX "sheet_order_rows_order_idx" ON "sheet_order_rows" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "sheet_order_rows_party_idx" ON "sheet_order_rows" USING btree ("billing_party_name");--> statement-breakpoint
CREATE INDEX "sheet_order_rows_customer_idx" ON "sheet_order_rows" USING btree ("matched_customer_id");--> statement-breakpoint
CREATE INDEX "sheet_order_rows_date_idx" ON "sheet_order_rows" USING btree ("order_date","id");--> statement-breakpoint
CREATE INDEX "sheet_order_rows_row_number_idx" ON "sheet_order_rows" USING btree ("row_number");--> statement-breakpoint
CREATE INDEX "sheet_order_rows_product_match_idx" ON "sheet_order_rows" USING btree ("product_match_status");--> statement-breakpoint
CREATE INDEX "sheet_sync_runs_source_idx" ON "sheet_sync_runs" USING btree ("source","started_at");