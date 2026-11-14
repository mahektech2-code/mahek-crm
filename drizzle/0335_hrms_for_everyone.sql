-- EVERYBODY WITH MAHEKONE HOLDS HRMS, as an associate.
--
-- Mahek asked for HRMS to be part of every account rather than a grant three
-- people held: an associate sees only their own records — their attendance,
-- leave and payslips — so giving it to everybody widens nobody's sight into
-- anybody else's. It is also what lets the workday clock reach the office
-- (`subjectOf` asks for an HRMS level first).
--
-- Only accounts that are active AND already hold some app: an account with
-- nothing granted was deliberately given nothing, and a disabled one keeps
-- the grants it had as a record rather than gaining new ones. A person who
-- already holds HRMS keeps their level. No module rows are written, which is
-- every HRMS screen — HRMS has no screen that is off by default, so that is
-- exactly what ticking it in the Access dialog selects.
--
-- THE INSERT IS DYNAMIC, and only runs where there are accounts to grant.
-- drizzle-kit applies every pending migration in one transaction, and Postgres
-- refuses to use an enum value added earlier in that same transaction — so on
-- a database built from nothing (CI, a fresh clone) the literals 'hrms' and
-- 'associate' would fail this migration with no error printed. Such a
-- database has no users, so the guard skips it; anywhere with users the
-- values were committed long ago.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "users") THEN
    EXECUTE '
INSERT INTO "app_access" ("id", "user_id", "app", "role")
SELECT ''acc_'' || substr(md5(u."id" || ''|hrms''), 1, 16),
       u."id",
       ''hrms'',
       ''associate''
  FROM "users" u
 WHERE u."active"
   AND EXISTS (SELECT 1 FROM "app_access" a WHERE a."user_id" = u."id")
   AND NOT EXISTS (SELECT 1 FROM "app_access" a WHERE a."user_id" = u."id" AND a."app"::text = ''hrms'')
';
  END IF;
END $$;
