-- A person wears several hats, and until now the account could hold one.
--
-- `users.role` was a single value and it decided three separate things: what
-- somebody may DO (the capability matrix), how much they may SEE (mine, team,
-- all), and which controls the screens draw. In a company of nine, one person
-- is the sales manager, the accounts clerk and the one who administers the
-- system — so whoever set the account up picked the most powerful of the three
-- and everything else came with it, silently.
--
-- Apps were already plural: `app_access` is one row per person per app. What
-- was missing is the ROLE that grant is held under. Vikram is a manager in the
-- CRM and a clerk in Accounts, and those are different powers over different
-- data, not one power applied twice.
--
-- NULL MEANS "the account's primary role", which is what every existing row
-- means today and what `npm run app:grant` still writes — a terminal that
-- knows nothing about roles must go on granting an app that works. The
-- backfill below writes the account's current role into every existing row, so
-- the day this lands every grant means exactly what it meant the day before.
alter table "app_access" add column "role" "role";
--> statement-breakpoint
update "app_access" a
   set "role" = u."role"
  from "users" u
 where u."id" = a."user_id" and a."role" is null;
--> statement-breakpoint
-- Answering "who approves orders" or "who may classify" now means reading the
-- roles beside the grants rather than the accounts table.
create index "app_access_role_idx" on "app_access" ("role");
--> statement-breakpoint
-- WHICH ROLE ALLOWED IT.
--
-- With one role per person, "was he allowed to do this" was answerable from
-- the person. With four it is not: the audit says Vikram approved an order,
-- and six months later nobody can tell whether he did it as the accounts clerk
-- (ordinary) or because his manager hat happened to carry it (which it does
-- not, and must not). The capability check knows which role granted it, so it
-- writes it down.
--
-- Null on every row that already exists, and on anything written outside a
-- capability check. Absence means "not recorded", never "no role".
alter table "audit_log" add column "actor_role" "role";
