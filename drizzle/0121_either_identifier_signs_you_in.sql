-- EITHER A WORK NUMBER OR AN EMAIL, and neither on its own is compulsory.
--
-- `signIn` has matched the last ten digits of a work number as readily as a
-- whole email since it was written, so both columns are credentials and
-- neither is THE credential. NOT NULL on the email meant that setting anybody
-- up demanded an address, and a field salesman issued a handset and a number
-- has no company mailbox — so somebody typed one in that nobody would ever
-- read. A fact invented to satisfy a column.
--
-- The real rule is "at least one", which no single-column constraint can see.
-- It lives in `setAccess`, where the two are weighed together.
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint

-- AND THE WORK NUMBER HAD NO UNIQUENESS AT ALL, which mattered less while it
-- was the second identifier and matters a great deal now that it is the only
-- one some accounts have. `signIn` resolves an identifier with `limit 1`, so
-- two accounts sharing a number meant whichever row came back first — signing
-- somebody in as a colleague, or refusing them because it checked the other
-- one's password. Application code in `setAccess` checked for the clash; only
-- an index can promise it.
--
-- Partial, because Postgres lets a unique index hold any number of NULLs and
-- there is nothing to keep apart about an absent number. Built WITHOUT the
-- concurrent option deliberately: this table is nine rows on the real
-- deployment and the migration runs behind a lock nobody is waiting on.
--
-- THE CHECK ABOVE IT IS SO THIS CANNOT FAIL SILENTLY-SHAPED. Adding a unique
-- index to a column that has never had one can refuse, and Postgres's own
-- refusal names the index rather than the data — "could not create unique
-- index" is a message that sends somebody to read this file instead of their
-- own users table. If two people genuinely share a number today, sign-in is
-- ALREADY picking one of them arbitrarily (`limit 1`), so the deploy stopping
-- is the first time anybody would find that out; it deserves the numbers and
-- the names, not a constraint name.
DO $$
DECLARE dup text;
BEGIN
  SELECT string_agg(phone || ' shared by ' || who, '; ')
    INTO dup
    FROM (
      SELECT phone, string_agg(name, ' and ') AS who
        FROM users
       WHERE phone IS NOT NULL
       GROUP BY phone
      HAVING count(*) > 1
    ) d;

  IF dup IS NOT NULL THEN
    RAISE EXCEPTION
      'Two accounts share a work number, so it cannot be made unique: %. Sign-in already resolves a number with limit 1, so one of them is being picked arbitrarily today. Decide which account keeps each number, clear the other, then deploy again.', dup;
  END IF;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "users_phone_key"
  ON "users" USING btree ("phone")
  WHERE "phone" IS NOT NULL;
