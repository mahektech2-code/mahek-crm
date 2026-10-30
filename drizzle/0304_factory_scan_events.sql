-- EVERY LOADING SCAN THE SERVER RECEIVES, kept before it is judged. The phone
-- sends its scans in batches, each with an id it minted; a row is written the
-- moment one arrives, so a scan that reached prod is on record even if judging
-- it fails, and a resend of the same id is answered from `result` rather than
-- judged twice. It is a log, never a ledger: the box on the lorry is still the
-- ERP's own scan row, written by the same `scanOntoOrder` the desk uses.
CREATE TABLE "factory_scan_events" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "lorry_key" text NOT NULL,
  "task_id" text,
  "code" text NOT NULL,
  "held" text,
  "scanned_at" timestamp with time zone,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "judged_at" timestamp with time zone,
  "status" text DEFAULT 'received' NOT NULL,
  "result" jsonb,
  "error" text,
  "judge_ms" integer,
  "wait_ms" integer,
  "app_build" text,
  CONSTRAINT "factory_scan_events_status_check" CHECK ("status" in ('received', 'accepted', 'repeat', 'refused', 'not_judged', 'error'))
);
--> statement-breakpoint
CREATE INDEX "factory_scan_events_lorry_idx" ON "factory_scan_events" ("godown_id", "lorry_key", "received_at");
--> statement-breakpoint
CREATE INDEX "factory_scan_events_open_idx" ON "factory_scan_events" ("received_at") WHERE "status" in ('received', 'error');
