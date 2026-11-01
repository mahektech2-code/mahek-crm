-- EVERY FACTORY PHONE, AS IT LAST DESCRIBED ITSELF. The factory app reports on
-- itself every few minutes while somebody is signed in: which APK and which
-- over-the-air update it runs, the handset, its network, how much work is
-- still waiting on it to be sent, and whether it may use the camera. One row
-- per phone, keyed on an id the phone minted once; `user_id` is whoever was
-- signed in when it last reported, because a station phone is shared. Read
-- by the Admin Console's Factory handsets page. It is a description, never a
-- credential: nothing signs in or is allowed because of a row here.
CREATE TABLE "factory_devices" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "godown_id" text REFERENCES "erp_godowns"("id"),
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "app_version" text,
  "app_build" text,
  "update_id" text,
  "update_created_at" timestamp with time zone,
  "runtime" text,
  "channel" text,
  "embedded" boolean,
  "os" text,
  "os_version" text,
  "api_level" integer,
  "brand" text,
  "manufacturer" text,
  "model" text,
  "network" text,
  "internet" boolean,
  "queue_pending" integer,
  "queue_held" integer,
  "queue_oldest_at" timestamp with time zone,
  "camera" text,
  "screen" text,
  "font_scale_pct" integer,
  "clock_skew_ms" integer,
  "lang" text
);
--> statement-breakpoint
CREATE INDEX "factory_devices_user_idx" ON "factory_devices" ("user_id");
--> statement-breakpoint
CREATE INDEX "factory_devices_seen_idx" ON "factory_devices" ("last_seen_at");
