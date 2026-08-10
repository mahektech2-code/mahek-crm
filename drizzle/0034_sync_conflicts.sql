-- Where the sheet and the app disagree, recorded rather than resolved.
--
-- The generator also offered `app_secrets`, which already exists: two branches
-- generated snapshots from the same parent and the merge left drizzle's chain
-- out of step with the database. Re-running that CREATE would fail on any
-- deployment already carrying it, so this migration holds only the new table.
CREATE TABLE "sync_conflicts" (
	"id" text PRIMARY KEY NOT NULL,
	"sync_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"field" text NOT NULL,
	"sheet_value" text,
	"app_value" text,
	"decided_by_id" text,
	"decided_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_id" text,
	"resolution" text
);
--> statement-breakpoint
-- One OPEN conflict per field per record: an uncorrected sheet would otherwise
-- re-report the same disagreement every thirty minutes, forever.
CREATE UNIQUE INDEX "sync_conflicts_open_key" ON "sync_conflicts" USING btree ("entity_type","entity_id","field") WHERE "sync_conflicts"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "sync_conflicts_open_idx" ON "sync_conflicts" USING btree ("resolved_at","detected_at");
