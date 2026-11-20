-- A workday claim ("I was working away from the screen") can be WITHDRAWN by
-- the person who made it, while it is pending: the time stays a break and the
-- row says so, rather than waiting for a manager to decline it.
ALTER TABLE "hrms_workday_claims" DROP CONSTRAINT IF EXISTS "hrms_workday_claims_status";
--> statement-breakpoint
ALTER TABLE "hrms_workday_claims" ADD CONSTRAINT "hrms_workday_claims_status" CHECK ("status" in ('pending','approved','declined','withdrawn'));
