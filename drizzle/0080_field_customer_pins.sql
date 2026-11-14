-- Shop locations backfilled from a third-party field-tracking app the
-- salesmen used to pin a shop's location before MBOS existed — a one-time
-- CSV export, not a live sheet, so there is no accompanying sheet_sync_runs
-- row and no watermark.
--
-- Hand-written rather than generated — this repo's drizzle-kit meta
-- snapshots are stale enough that `generate` re-emits old migrations.
--
-- customers_name_trgm_idx (migration 0072) and pg_trgm (migration 0008) are
-- already in place — the same similarity() match this import uses reuses
-- that index rather than needing a new one.
CREATE TABLE "field_customer_pins" (
	"id" text PRIMARY KEY NOT NULL,
	"row_hash" text NOT NULL,
	"raw" jsonb NOT NULL,
	"name" text NOT NULL,
	"print_as" text,
	"location_text" text,
	"territory" text,
	"industry_label" text,
	"address" text,
	"lat" double precision,
	"lng" double precision,
	"source_added_by_name" text,
	"source_added_at" timestamp with time zone,
	"source_updated_by_name" text,
	"source_updated_at" timestamp with time zone,
	"added_by_user_id" text,
	"added_by_match_status" "sheet_match_status" DEFAULT 'pending' NOT NULL,
	"matched_customer_id" text,
	"customer_match_status" "sheet_match_status" DEFAULT 'pending' NOT NULL,
	"match_note" text,
	"gps_applied_at" timestamp with time zone,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "field_customer_pins" ADD CONSTRAINT "field_customer_pins_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_customer_pins" ADD CONSTRAINT "field_customer_pins_matched_customer_id_customers_id_fk" FOREIGN KEY ("matched_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "field_customer_pins_row_hash_idx" ON "field_customer_pins" USING btree ("row_hash");--> statement-breakpoint
CREATE INDEX "field_customer_pins_customer_idx" ON "field_customer_pins" USING btree ("matched_customer_id");--> statement-breakpoint
CREATE INDEX "field_customer_pins_customer_match_idx" ON "field_customer_pins" USING btree ("customer_match_status");--> statement-breakpoint
CREATE INDEX "field_customer_pins_added_by_idx" ON "field_customer_pins" USING btree ("added_by_user_id");--> statement-breakpoint
CREATE INDEX "field_customer_pins_unapplied_idx" ON "field_customer_pins" USING btree ("customer_match_status","gps_applied_at");
