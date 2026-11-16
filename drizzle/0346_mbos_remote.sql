-- MBOS REMOTE CONTROL (Nov 2026). Switches, sentences and banners the office
-- can change on a salesman's phone without an APK or an over-the-air bundle.
-- Read by lib/services/mbos-remote-service.ts, rules in lib/engines/mbos-remote.ts.
--
-- Its own table, NOT more rows in app_settings, and the key CHECK is the
-- reason: a key here can only start with feature., menu., text. or banner.,
-- so nothing written here can ever shadow a configuration key, and in
-- particular none of the mbos.location.* settings the trail runs on. The
-- words that name location are refused as well.
CREATE TABLE IF NOT EXISTS "mbos_remote_items" (
  "key" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "value" jsonb NOT NULL,
  "audience" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_by_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mbos_remote_items_kind" CHECK ("kind" in ('flag','text','banner')),
  CONSTRAINT "mbos_remote_items_key_namespace" CHECK ("key" ~ '^(feature|menu|text|banner)\.[a-z0-9][a-z0-9._-]{0,79}$'),
  CONSTRAINT "mbos_remote_items_never_location" CHECK ("key" !~ '(location|tracking|trail|gps|fix|position|geofence|punch)')
);
