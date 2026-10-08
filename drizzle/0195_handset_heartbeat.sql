-- What a handset said about itself on its latest request, so the Admin
-- Console's Handsets table shows the build a phone is actually running from
-- the first sync after an upgrade, not from whenever somebody last signed in.
--
--   last_request_at          any authenticated MBOS request from this device
--   app_version_reported_at  the last request that carried x-mbos-app-version
--   app_version_changed_at   when app_version last moved to a new value
--
-- All nullable and unfilled: a row written before this has never reported,
-- and "never reported" is not the same as "reported at bind time".
ALTER TABLE mbos_devices ADD COLUMN IF NOT EXISTS last_request_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE mbos_devices ADD COLUMN IF NOT EXISTS app_version_reported_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE mbos_devices ADD COLUMN IF NOT EXISTS app_version_changed_at timestamp with time zone;
