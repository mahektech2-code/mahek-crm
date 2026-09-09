-- Which HRMS employee an account belongs to, said rather than guessed.
--
-- Salary, days worked and reimbursements are all read by joining `users` to
-- `employees` on `lower(email)` or on `company_mobile = users.phone`. That
-- heuristic finds nobody on the real book: 56 of 71 employees carry no email
-- at all, the accounts are `@mahek.in` while the sheet holds personal gmail
-- addresses, and the work numbers on the accounts are not the company mobiles
-- in the sheet. Every field salesman's pay therefore read as blank on the
-- Sales Dashboard and on the handset, on a screen where a missing number is
-- indistinguishable from a zero one.
--
-- It cannot be fixed by matching harder. The book carries two rows named for
-- the same person -- `Pritesh Doshi` at one salary and `Pritesh Bipin Doshi`
-- at another, sharing a company mobile -- so a name match would pick one, be
-- wrong half the time, and be wrong about somebody's PAY. This is the same
-- rule the catalogue import already follows for a name carried by two legacy
-- product ids: held, never auto-picked.
--
-- Nullable, and no backfill. An account with no link keeps exactly the
-- behaviour it has today, because every read falls back to the old heuristic
-- where this is null -- so adding it moves no figure on any screen, and a
-- figure only changes on the day somebody deliberately links an account.
--
-- `on delete set null`: HRMS marks a leaver rather than deleting them, so this
-- fires only if a row genuinely leaves the master. An account outliving its
-- employee row is an account with no pay to show, not an account to delete.
alter table "users" add column if not exists "employee_id" text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_employee_id_employees_id_fk'
  ) then
    alter table "users"
      add constraint "users_employee_id_employees_id_fk"
      foreign key ("employee_id") references "employees"("id") on delete set null;
  end if;
end $$;

-- One account per employee. Two accounts claiming one payroll row would show
-- the same salary twice and there would be no way to tell which was meant.
create unique index if not exists "users_employee_key" on "users" ("employee_id")
  where "employee_id" is not null;
