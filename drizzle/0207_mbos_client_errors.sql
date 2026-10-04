-- What went wrong on a handset, sent up by the handset itself. MBOS recorded
-- no error anywhere: a crashed screen kept its message on the phone, and a
-- fatal error outside a render left nothing at all. See `mbosClientErrors`.
CREATE TABLE IF NOT EXISTS "mbos_client_errors" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "device_id" text NOT NULL,
  "app_version" text,
  "kind" text NOT NULL,
  "message" text NOT NULL,
  "stack" text,
  "screen" text,
  "occurred_at" timestamp with time zone,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mbos_client_errors_client_key" ON "mbos_client_errors" ("device_id", "client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mbos_client_errors_received_idx" ON "mbos_client_errors" ("received_at");
