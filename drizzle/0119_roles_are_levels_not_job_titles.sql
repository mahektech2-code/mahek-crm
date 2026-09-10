-- A ROLE IS A LEVEL, AND THE APP IS THE JOB.
--
-- `role` held four values and they were two different ideas in one list.
-- `manager` and `admin` are levels of seniority; `telecaller` and `accounts`
-- are job titles borrowed from two particular apps. So the moment a grant was
-- for any THIRD app — the Salesman App, Reports, HRMS — the list had no honest
-- word for "ordinary worker" and offered the CRM's job title instead. The
-- Access screen has been asking managers to make a field salesman a telecaller
-- since the day a second app shipped, and the seed agrees: mahesh@mahek.in,
-- who has never made a phone call for this company, is stored as one.
--
-- `telecaller` was ALREADY the base level rather than a job. `can()` ends with
-- `return !MANAGER_ONLY.has(capability)` — you hold anything not explicitly
-- withheld — which is the definition of an associate and is why a salesman
-- could be given that value and work correctly.
--
-- So: three levels, and the APP the grant is held under supplies the function.
-- `app_access` has stored one row per person per app since roles were split
-- off `users.role`, so the pair was already there to be read; nothing but the
-- vocabulary is new.
--
--   associate on Accounts        = the clerk who confirms money
--   associate on Telecaller CRM  = the telecaller
--   associate on Salesman App    = the field salesman
--   manager   on Telecaller CRM  = runs the calling book, and STILL cannot
--                                  approve an order, which is the whole point
--   admin                        = everything, everywhere
--
-- Postgres cannot drop a value from an enum, and `ALTER TYPE ... ADD VALUE`
-- may not be USED in the transaction that adds it — drizzle-kit applies every
-- pending migration in one. Both rule out editing the type in place, so a new
-- type is built and the columns are moved onto it with an explicit mapping.

CREATE TYPE "role_level" AS ENUM('associate', 'manager', 'admin');--> statement-breakpoint

-- EVERY COMPARISON HERE IS ON TEXT, and that is not a style choice.
--
-- `accounts` was added to the `role` enum by `ALTER TYPE ... ADD VALUE` in
-- 0012, and Postgres refuses to USE a value added to an enum until the
-- transaction that added it commits. drizzle-kit applies every pending
-- migration in ONE transaction, so on a database that has never been migrated
-- — CI, a new laptop — 0012 and this file are in the same transaction and
-- `WHERE role = 'accounts'` fails with "unsafe use of new value".
--
-- It is the same rule AGENTS.md already states for granting a new app id in
-- the migration that adds it, arriving from the other end: not adding a value
-- and using it, but READING one somebody else added. And it fails in the
-- worst possible pattern — production has had `accounts` committed since 0012
-- and would have applied this happily, so it would have gone green on the
-- deploy and red on the next fresh checkout, or the reverse.
--
-- `role::text = 'accounts'` compares the label rather than the enum value, so
-- nothing here depends on when that value was committed.

-- THE BACKFILL COMES FIRST, and it is the only part of this that can lose
-- something.
--
-- `accounts` becomes MANAGER, not associate, and that is the whole of the
-- care needed here. Everything that made an accounts clerk an accounts clerk —
-- approving an order, confirming a payment, issuing a credit note — is the
-- Accounts MANAGER's under the new matrix; an associate at that desk records
-- and reads. Mapping the old role to `associate` because it "feels junior"
-- would take order approval away from the only person who has it, and the
-- approvals queue would stop on deploy day with nothing on any screen saying
-- why.
--
-- The level is only half of it: the powers hang on holding the Accounts APP
-- as well. Anybody carrying the old role WITHOUT that grant would come out the
-- other side as an ordinary manager, so they are given the grant their role
-- has been standing in for.
--
-- `role` is left NULL on the new row deliberately: null means "the account's
-- own", which is what every grant meant before the column existed and is what
-- `npm run app:grant` still writes.
INSERT INTO "app_access" ("id", "user_id", "app", "granted_by_id", "created_at")
SELECT
  'aac_' || substr(md5(random()::text || u."id"), 1, 12),
  u."id",
  'accounts'::"app_id",
  NULL,
  now()
FROM "users" u
WHERE u."role"::text = 'accounts'
  AND NOT EXISTS (
    SELECT 1 FROM "app_access" a
    WHERE a."user_id" = u."id" AND a."app" = 'accounts'
  );--> statement-breakpoint

-- The same for a grant held UNDER the accounts hat on some other app. That row
-- says "this person does this app's work as an accounts clerk", which under
-- the new vocabulary is an associate who also holds Accounts.
INSERT INTO "app_access" ("id", "user_id", "app", "granted_by_id", "created_at")
SELECT DISTINCT
  'aac_' || substr(md5(random()::text || a."user_id"), 1, 12),
  a."user_id",
  'accounts'::"app_id",
  NULL,
  now()
FROM "app_access" a
WHERE a."role"::text = 'accounts'
  AND NOT EXISTS (
    SELECT 1 FROM "app_access" b
    WHERE b."user_id" = a."user_id" AND b."app" = 'accounts'
  );--> statement-breakpoint

-- AND THE GRANT SAYS WHICH, so that nobody quietly GAINS the desk.
--
-- A grant with no role of its own falls back to the account's level. That was
-- harmless while `accounts` was a role — holding the Accounts app let you OPEN
-- it and the role decided what you could do inside — and it stops being
-- harmless the moment the level inside the app unlocks the decisions.
--
-- Vikram is the case. He is a `manager` who holds the Accounts app so he can
-- see the queue, and the matrix kept `order.approve` away from him ON PURPOSE:
-- the person chasing a target must not sign off the orders that hit it. Leave
-- his grant NULL and it now resolves to manager-in-Accounts, and he can — a
-- silent escalation, on migration, for the one rule this matrix exists to
-- enforce.
--
-- So the Accounts grants are made EXPLICIT rather than left to fall back:
-- manager for whoever actually was the desk, associate for everybody else who
-- could merely open it. Both keep exactly the powers they had this morning.
-- `manager` and `associate` are safe to write here: `manager` is an original
-- value of the enum and `associate` is the one being introduced by the type
-- swap below, which has not happened yet — so this runs against the OLD type,
-- where only `manager` exists. `associate` is therefore written after it.
UPDATE "app_access" a
SET "role" = 'manager'
FROM "users" u
WHERE a."user_id" = u."id"
  AND a."app" = 'accounts'
  AND a."role" IS NULL
  AND u."role"::text = 'accounts';--> statement-breakpoint

ALTER TABLE "users"
  ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint

ALTER TABLE "users"
  ALTER COLUMN "role" TYPE "role_level"
  USING (CASE "role"::text
    WHEN 'telecaller' THEN 'associate'
    WHEN 'accounts'   THEN 'manager'
    ELSE "role"::text
  END)::"role_level";--> statement-breakpoint

ALTER TABLE "users"
  ALTER COLUMN "role" SET DEFAULT 'associate';--> statement-breakpoint

ALTER TABLE "app_access"
  ALTER COLUMN "role" TYPE "role_level"
  USING (CASE "role"::text
    WHEN 'telecaller' THEN 'associate'
    WHEN 'accounts'   THEN 'manager'
    ELSE "role"::text
  END)::"role_level";--> statement-breakpoint

-- WHICH HAT ALLOWED IT needs two columns now, not one.
--
-- `actor_role` was a complete answer while a role named the job: "accounts"
-- said the clerk did it and "manager" said seniority carried it. `associate`
-- says neither. The app is the other half, and without it the column stops
-- distinguishing the clerk doing their job from anybody else on the payroll —
-- which is the exact question the column was added to answer.
--
-- Existing rows keep their meaning: an old `accounts` row becomes
-- `associate` + `accounts`, and an old `telecaller` row becomes `associate`
-- with no app, because there was no app recorded and inventing one would be
-- worse than admitting it.
ALTER TABLE "audit_log" ADD COLUMN "actor_app" "app_id";--> statement-breakpoint

UPDATE "audit_log" SET "actor_app" = 'accounts' WHERE "actor_role"::text = 'accounts';--> statement-breakpoint

ALTER TABLE "audit_log"
  ALTER COLUMN "actor_role" TYPE "role_level"
  USING (CASE "actor_role"::text
    WHEN 'telecaller' THEN 'associate'
    WHEN 'accounts'   THEN 'manager'
    ELSE "actor_role"::text
  END)::"role_level";--> statement-breakpoint

-- `lead_stage_transitions.actor_role` is plain text rather than the enum, so
-- it is rewritten rather than re-typed. Same mapping, same reason.
ALTER TABLE "lead_stage_transitions" ADD COLUMN "actor_app" text;--> statement-breakpoint
UPDATE "lead_stage_transitions" SET "actor_app" = 'accounts' WHERE "actor_role" = 'accounts';--> statement-breakpoint
UPDATE "lead_stage_transitions" SET "actor_role" = 'associate' WHERE "actor_role" = 'telecaller';--> statement-breakpoint
UPDATE "lead_stage_transitions" SET "actor_role" = 'manager' WHERE "actor_role" = 'accounts';--> statement-breakpoint

-- The other half, and it has to come AFTER the swap because `associate` does
-- not exist until it. Anybody holding Accounts whose grant is still unspoken
-- was not the desk: they could open the app and could not approve, and this
-- is what keeps that true.
UPDATE "app_access"
SET "role" = 'associate'
WHERE "app" = 'accounts' AND "role" IS NULL;--> statement-breakpoint

DROP TYPE "role";--> statement-breakpoint
ALTER TYPE "role_level" RENAME TO "role";
