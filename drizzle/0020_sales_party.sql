CREATE TABLE "sheet_party_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"sync_id" text NOT NULL,
	"row_number" integer NOT NULL,
	"party_name" text NOT NULL,
	"party_key" text NOT NULL,
	"raw" jsonb NOT NULL,
	"row_hash" text NOT NULL,
	"status" "sheet_row_status" DEFAULT 'present' NOT NULL,
	"last_seen_sync_id" text,
	"area" text,
	"location" text,
	"state" text,
	"mobile_no" text,
	"whatsapp_no" text,
	"email" text,
	"sales_person_name" text,
	"back_office_name" text,
	"credit_days" integer,
	"gst_number" text,
	"grade" text,
	"monthly_target_paise" bigint,
	"tag_pricelist" text,
	"segment" text,
	"counter_type" text,
	"standing_instructions" text,
	"calling_instructions" text,
	"transport_detail" text,
	"payment_type" text,
	"delivery_type" text,
	"weight_type" text,
	"party_status" text,
	"company_name" text,
	"allocate_email" text,
	"since_date" date,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sheet_party_rows" ADD CONSTRAINT "sheet_party_rows_sync_id_sheet_sync_runs_id_fk" FOREIGN KEY ("sync_id") REFERENCES "public"."sheet_sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sheet_party_rows_key" ON "sheet_party_rows" USING btree ("party_key");--> statement-breakpoint
CREATE INDEX "sheet_party_rows_sync_idx" ON "sheet_party_rows" USING btree ("sync_id");--> statement-breakpoint
CREATE INDEX "sheet_party_rows_name_idx" ON "sheet_party_rows" USING btree ("party_name");--> statement-breakpoint
CREATE INDEX "sheet_party_rows_status_idx" ON "sheet_party_rows" USING btree ("party_status");