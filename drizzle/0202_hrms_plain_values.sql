-- The HRMS's stored words were Mahek EMP 2.0's own spellings — a grievance
-- closed as "Solve", a help request typed "I Forgot Make Attendance", an office
-- open "24*7", a checklist item "N/A". They are plain words now, in the data
-- and in the code, which names them once in src/lib/hrms/values.ts (RENAMED is
-- this file's twin, and a test holds the two together).
--
-- Every UPDATE matches the old word exactly, so re-running finds nothing.

UPDATE "hrms_leave_requests" SET "status" = 'Waiting' WHERE "status" = 'Requesting';
UPDATE "hrms_grievances" SET "status" = 'Answered' WHERE "status" = 'Solve';
UPDATE "hrms_buddy_tasks" SET "status" = 'Done' WHERE "status" = 'Task done';
UPDATE "hrms_checklist" SET "status" = 'Not applicable' WHERE "status" = 'N/A';
UPDATE "hrms_offices" SET "timing_type" = '24 hours' WHERE "timing_type" = '24*7';
UPDATE "hrms_asset_stock" SET "category" = 'Equipment' WHERE "category" = 'Tangible Assets';
UPDATE "hrms_expenses" SET "pay_type" = 'Claim' WHERE "pay_type" = 'Expense Claim';
UPDATE "hrms_expenses" SET "pay_type" = 'Payment' WHERE "pay_type" = 'Expense Paid';
UPDATE "hrms_holidays" SET "category" = 'Weather' WHERE "category" = 'Nature';
UPDATE "hrms_help" SET "type" = 'Forgot to check in' WHERE "type" = 'I Forgot Make Attendance';
UPDATE "hrms_help" SET "type" = 'Checked in late' WHERE "type" = 'I Late Check In';
UPDATE "hrms_help" SET "type" = 'Forgot to check out' WHERE "type" = 'I Forget Check Out';
UPDATE "hrms_help" SET "type" = 'Running late today' WHERE "type" = 'I Am Late Today';
UPDATE "hrms_help" SET "type" = 'Overtime not approved' WHERE "type" = 'OT Not Approved';
UPDATE "hrms_help" SET "type" = 'Help learning the app' WHERE "type" = 'I Want to Lean App';

ALTER TABLE "hrms_leave_requests" ALTER COLUMN "status" SET DEFAULT 'Waiting';

-- The pick list the holiday form offers.
UPDATE "hrms_ref_lists"
   SET "values" = (SELECT jsonb_agg(CASE WHEN v = 'Nature' THEN 'Weather' ELSE v END) FROM jsonb_array_elements_text("values") AS v)
 WHERE "list" = 'Holiday categories' AND "values" ? 'Nature';
