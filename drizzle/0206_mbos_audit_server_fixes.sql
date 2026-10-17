-- Where a notification goes on the HANDSET, stored on the row rather than
-- carried on the push alone. The phone's bell list is filled from this table
-- on every pull and was being handed the web `href`, which is a route the
-- handset's router has never heard of.
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "mbos_href" text;
