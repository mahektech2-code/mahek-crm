-- "This account is not an employee" — said by an administrator, so an account
-- that genuinely has no HRMS record (a shared desk login, an outside
-- accountant) stops sitting on the "Not linked to HRMS" list for ever, and is
-- never guessed onto somebody's payroll row by email, number or name.
-- See lib/engines/person-directory.ts.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "not_employee" boolean DEFAULT false NOT NULL;
