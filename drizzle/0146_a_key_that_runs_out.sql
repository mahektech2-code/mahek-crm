-- WHAT IS KNOWN ABOUT AN OLA MAPS KEY THAT RAN OUT.
--
-- One row per credential NAME, and deliberately not two columns on
-- `app_secrets`: a key can come from the environment instead of the console,
-- in which case there is no `app_secrets` row to carry the state at all. The
-- fact recorded here is about the account behind the name, not about the row
-- somebody typed the value into.
--
-- It is not `app_settings` either. Settings are rendered on screens, exported
-- as JSON and audited with their before and after values, which is right for a
-- threshold somebody chose and wrong for a fact observed from a provider's
-- refusal — nobody decided this and there is nothing to audit.
--
-- NO VALUE, NO TAIL, NOTHING SPENDABLE. The name is all that is stored.
create table if not exists ola_key_health (
  name text primary key,
  -- When Ola last refused this key for quota. The cooldown runs from here, and
  -- a failed retry moves it, so the cooldown restarts rather than the key
  -- being re-tried on every call from then on.
  spent_at timestamptz,
  -- The month that refusal belongs to, YYYY-MM in Asia/Kolkata. Stored rather
  -- than derived from spent_at on read: a month read off a bare instant is the
  -- same bug as a bare cast to a date, one calendar unit up.
  spent_month text,
  -- Which signal retired it, for a person reading the console: http_429, or
  -- http_403_quota, or body_quota. Never a message from Ola verbatim, which
  -- could carry anything.
  spent_signal text,
  updated_at timestamptz not null default now()
);
