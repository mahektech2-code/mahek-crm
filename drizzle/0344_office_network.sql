-- An office's own internet connection counts as being in the office: a
-- desktop's browser can only guess its location, often a kilometre out.
ALTER TABLE "hrms_offices" ADD COLUMN IF NOT EXISTS "network_ips" text[] DEFAULT '{}'::text[] NOT NULL;
