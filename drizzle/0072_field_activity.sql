-- Field salesman activity backfill: a historical visit/call log from a
-- defunct prior system ("Mahek EMP 2.0"), imported the same way the order
-- sheet and the HR sheet are.
--
-- Hand-written rather than generated — this repo's drizzle-kit meta
-- snapshots are stale enough that `generate` re-emits old migrations.
--
-- `customers.name` has no trigram index yet (only the plain btree from
-- migration 0000); the customer-name matching this import needs reuses the
-- same `similarity()` pattern product search already uses, so it needs the
-- same kind of index. `pg_trgm` itself was already enabled by migration 0008.
CREATE INDEX IF NOT EXISTS customers_name_trgm_idx
	ON customers USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE TABLE "sheet_field_activity_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"sync_id" text NOT NULL,
	"row_number" integer NOT NULL,
	"activity_id" text NOT NULL,
	"raw" jsonb NOT NULL,
	"row_hash" text NOT NULL,
	"status" "sheet_row_status" DEFAULT 'present' NOT NULL,
	"last_seen_sync_id" text,
	"employee_name" text,
	"matched_salesman_id" text,
	"salesman_match_status" "sheet_match_status" DEFAULT 'pending' NOT NULL,
	"customer_name" text,
	"matched_customer_id" text,
	"customer_match_status" "sheet_match_status" DEFAULT 'pending' NOT NULL,
	"match_note" text,
	"visit_date" date,
	"duration_minutes" integer,
	"meeting_note" text,
	"issue_note" text,
	"reminder_date" date,
	"mood_raw" text,
	"mood" text,
	"stage_label" text,
	"meeting_type" text,
	"meeting_purpose" text,
	"location" text,
	"timeline_event_written" boolean DEFAULT false NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sheet_field_activity_rows" ADD CONSTRAINT "sheet_field_activity_rows_sync_id_sheet_sync_runs_id_fk" FOREIGN KEY ("sync_id") REFERENCES "public"."sheet_sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_field_activity_rows" ADD CONSTRAINT "sheet_field_activity_rows_matched_salesman_id_users_id_fk" FOREIGN KEY ("matched_salesman_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_field_activity_rows" ADD CONSTRAINT "sheet_field_activity_rows_matched_customer_id_customers_id_fk" FOREIGN KEY ("matched_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sheet_field_activity_rows_activity_id" ON "sheet_field_activity_rows" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "sheet_field_activity_rows_sync_idx" ON "sheet_field_activity_rows" USING btree ("sync_id");--> statement-breakpoint
CREATE INDEX "sheet_field_activity_rows_salesman_idx" ON "sheet_field_activity_rows" USING btree ("matched_salesman_id");--> statement-breakpoint
CREATE INDEX "sheet_field_activity_rows_customer_idx" ON "sheet_field_activity_rows" USING btree ("matched_customer_id");--> statement-breakpoint
CREATE INDEX "sheet_field_activity_rows_date_idx" ON "sheet_field_activity_rows" USING btree ("visit_date","id");--> statement-breakpoint
CREATE INDEX "sheet_field_activity_rows_customer_match_idx" ON "sheet_field_activity_rows" USING btree ("customer_match_status");--> statement-breakpoint
CREATE INDEX "sheet_field_activity_rows_unprojected_idx" ON "sheet_field_activity_rows" USING btree ("customer_match_status","timeline_event_written");
