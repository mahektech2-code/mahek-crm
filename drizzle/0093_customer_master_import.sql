-- The shop master of the defunct prior system ("Mahek EMP 2.0") — the
-- `Customer Details` tab, 5,292 rows, and the only place a phone number for
-- these shops exists. The Activity tab was imported by 0072 and carries no
-- contact detail at all; the GPS pin export (0081) carries coordinates and,
-- despite having CustomerPhone1/2/3 columns, exactly one filled cell in 6,525.
--
-- Hand-written rather than generated — this repo's drizzle-kit meta snapshots
-- are stale enough that `generate` re-emits old migrations.
--
-- Idempotent throughout: this branch already had to make six migrations
-- re-runnable after a half-applied deploy, and a table created by hand
-- against prod must not make the next deploy's migrate step fail.
--
-- Staging only. Nothing here writes a `customers` row: the projection is a
-- separate, dry-runnable pass, so what the sheet said stays recoverable
-- whatever the published side is later made to look like.
CREATE TABLE IF NOT EXISTS "sheet_customer_master_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"sync_id" text NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"row_hash" text NOT NULL,
	"status" "sheet_row_status" DEFAULT 'present' NOT NULL,
	"last_seen_sync_id" text,

	"customer_name" text NOT NULL,
	"name_key" text NOT NULL,

	"mobile_raw" text,
	"mobile" text,
	"alt_mobile" text,

	"address" text,
	"location_text" text,
	"state" text,

	"rating" text,
	"segmentation" text,
	"special_instructions" text,

	"sales_person_name" text,
	"tag_employee_name" text,
	"back_office_name" text,

	"sheet_status" text,
	"deactivation_request" text,
	"deactivation_remark" text,

	-- Which MahekOne customer this row is, once the projection has decided.
	-- Free text on both sides, same discipline as every other staging table:
	-- more than one close candidate is `ambiguous`, never auto-picked.
	"matched_customer_id" text,
	"customer_match_status" "sheet_match_status" DEFAULT 'pending' NOT NULL,
	"match_note" text,

	-- What the projection concluded, and WHY. The evidence is kept beside the
	-- verdict because "why is this shop a lead" is asked months later, by
	-- somebody looking at one row, and a rule re-run from memory is not an
	-- answer about this row.
	"resolved_kind" text,
	"resolved_status" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,

	-- Set once the row has produced (or updated) its customer. Separate from
	-- the match for the same reason `field_customer_pins.gps_applied_at` is:
	-- matching decides WHICH customer and is safe to redo, projecting WRITES.
	"projected_customer_id" text,
	"projected_at" timestamp with time zone,

	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,

	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	-- Matched on the COLUMN, never the name: Postgres truncates an
	-- identifier at 63 characters, and two of these three names are
	-- longer than that. A name-based guard would never match what was
	-- actually stored, so every re-run would try to add the constraint
	-- again and fail — which is the exact failure this branch exists to
	-- stop.
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint c
		 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
		WHERE c.conrelid = 'sheet_customer_master_rows'::regclass
		  AND c.contype = 'f'
		  AND a.attname = 'sync_id'
	) THEN
		ALTER TABLE "sheet_customer_master_rows"
		ADD CONSTRAINT "sheet_customer_master_rows_sync_id_sheet_sync_runs_id_fk"
		FOREIGN KEY ("sync_id") REFERENCES "public"."sheet_sync_runs"("id")
		ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	-- Matched on the COLUMN, never the name: Postgres truncates an
	-- identifier at 63 characters, and two of these three names are
	-- longer than that. A name-based guard would never match what was
	-- actually stored, so every re-run would try to add the constraint
	-- again and fail — which is the exact failure this branch exists to
	-- stop.
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint c
		 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
		WHERE c.conrelid = 'sheet_customer_master_rows'::regclass
		  AND c.contype = 'f'
		  AND a.attname = 'matched_customer_id'
	) THEN
		ALTER TABLE "sheet_customer_master_rows"
		ADD CONSTRAINT "sheet_customer_master_rows_matched_customer_id_customers_id_fk"
		FOREIGN KEY ("matched_customer_id") REFERENCES "public"."customers"("id")
		ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	-- Matched on the COLUMN, never the name: Postgres truncates an
	-- identifier at 63 characters, and two of these three names are
	-- longer than that. A name-based guard would never match what was
	-- actually stored, so every re-run would try to add the constraint
	-- again and fail — which is the exact failure this branch exists to
	-- stop.
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint c
		 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
		WHERE c.conrelid = 'sheet_customer_master_rows'::regclass
		  AND c.contype = 'f'
		  AND a.attname = 'projected_customer_id'
	) THEN
		ALTER TABLE "sheet_customer_master_rows"
		ADD CONSTRAINT "sheet_customer_master_rows_projected_customer_id_customers_id_fk"
		FOREIGN KEY ("projected_customer_id") REFERENCES "public"."customers"("id")
		ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
-- The natural key. The tab has no id column of its own, so the normalised
-- name is it — which is also why the projection has to report duplicates
-- rather than silently keeping the last one it saw.
CREATE UNIQUE INDEX IF NOT EXISTS "sheet_customer_master_rows_name_key_idx"
	ON "sheet_customer_master_rows" USING btree ("name_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sheet_customer_master_rows_sync_idx"
	ON "sheet_customer_master_rows" USING btree ("sync_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sheet_customer_master_rows_mobile_idx"
	ON "sheet_customer_master_rows" USING btree ("mobile");
--> statement-breakpoint
-- The projection's own worklist: rows that have not yet produced a customer.
CREATE INDEX IF NOT EXISTS "sheet_customer_master_rows_unprojected_idx"
	ON "sheet_customer_master_rows" USING btree ("status", "projected_at");
