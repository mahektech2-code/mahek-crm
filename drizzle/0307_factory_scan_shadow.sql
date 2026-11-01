-- WHAT THE PHONE THOUGHT, BESIDE WHAT THE SERVER DECIDED. The phone judges each
-- lorry scan against a loading pack it downloaded (`lorry-judge.ts`) and sends
-- that answer with the scan; the server still judges every one and stores both.
-- `agree` is null where the phone could not judge (a code its pack does not
-- carry, a lot label) — that is a gap in the pack, not a wrong answer. A week
-- of these decides whether a phone may count a box on its own.
ALTER TABLE "factory_scan_events" ADD COLUMN "local_result" text;
--> statement-breakpoint
ALTER TABLE "factory_scan_events" ADD COLUMN "local_line" text;
--> statement-breakpoint
ALTER TABLE "factory_scan_events" ADD COLUMN "local_why" text;
--> statement-breakpoint
ALTER TABLE "factory_scan_events" ADD COLUMN "local_us" integer;
--> statement-breakpoint
ALTER TABLE "factory_scan_events" ADD COLUMN "pack_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "factory_scan_events" ADD COLUMN "server_line" text;
--> statement-breakpoint
ALTER TABLE "factory_scan_events" ADD COLUMN "agree" boolean;
--> statement-breakpoint
CREATE INDEX "factory_scan_events_disagree_idx" ON "factory_scan_events" ("received_at") WHERE "agree" = false;
