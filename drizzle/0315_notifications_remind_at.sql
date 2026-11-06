-- "Remind me in 30 minutes" on the ERP's notification pop-up. Null means nobody
-- asked to be reminded. The browser's own polling brings it back when it is due,
-- so no scheduled job reads this.
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "remind_at" timestamp with time zone;
