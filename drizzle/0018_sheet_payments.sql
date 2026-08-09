CREATE TABLE "sheet_payment_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"sync_id" text NOT NULL,
	"row_number" integer NOT NULL,
	"order_number" text NOT NULL,
	"raw" jsonb NOT NULL,
	"row_hash" text NOT NULL,
	"status" "sheet_row_status" DEFAULT 'present' NOT NULL,
	"last_seen_sync_id" text,
	"billing_party_name" text,
	"tally_bill_no" text,
	"dispatch_date" date,
	"bill_amount_paise" bigint,
	"due_date" date,
	"payment_status" text,
	"payment_received_date" date,
	"message_date" date,
	"next_message_date" date,
	"back_office" text,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sheet_payment_rows" ADD CONSTRAINT "sheet_payment_rows_sync_id_sheet_sync_runs_id_fk" FOREIGN KEY ("sync_id") REFERENCES "public"."sheet_sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sheet_payment_rows_order_key" ON "sheet_payment_rows" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "sheet_payment_rows_sync_idx" ON "sheet_payment_rows" USING btree ("sync_id");--> statement-breakpoint
CREATE INDEX "sheet_payment_rows_party_idx" ON "sheet_payment_rows" USING btree ("billing_party_name");--> statement-breakpoint
CREATE INDEX "sheet_payment_rows_status_idx" ON "sheet_payment_rows" USING btree ("payment_status");