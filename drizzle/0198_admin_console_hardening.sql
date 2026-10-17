-- THE ADMIN CONSOLE ASKS FOR THE PASSWORD AGAIN, and a password can no longer
-- be guessed at a thousand times a minute.
--
-- 1. When this session last proved its password. Signing in sets it; the
--    console refuses a session whose proof is older than
--    `auth.console.confirmMinutes`, and every console page a confirmed session
--    opens moves it forward. Null — every session that exists today, and every
--    session an impersonation link opens — is a session that has to confirm
--    before the console will open. Nobody is signed out by this.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
--> statement-breakpoint
-- 2. One row per wrong password. `account` is the user id where the name typed
--    matched somebody and the normalised name where it did not, so a phone
--    number and an email for one person share a count. `address` is the
--    client IP Caddy reports. Rows older than a day are deleted as new ones
--    arrive; nothing reads further back than the window.
CREATE TABLE IF NOT EXISTS sign_in_failures (
  id text PRIMARY KEY,
  account text NOT NULL,
  address text,
  at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sign_in_failures_account_idx ON sign_in_failures (account, at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sign_in_failures_address_idx ON sign_in_failures (address, at);
