-- CONTACT BIRTHDAYS (0227) — ADDITIVE ONLY.
--
-- Each person at a customer may carry a birthday as a day and a month, never
-- a year. Both columns are nullable and nothing is backfilled: null is
-- "nobody asked", which is true of every contact that exists today.
--
-- The check names `is not null` on the second arm because a comparison with a
-- null is null, and a CHECK passes on null — without it a day with no month
-- would be accepted.
ALTER TABLE "customer_contacts" ADD COLUMN "birth_day" smallint;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD COLUMN "birth_month" smallint;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_birthday_check"
  CHECK (("birth_day" is null and "birth_month" is null)
      or ("birth_day" is not null and "birth_month" is not null
          and "birth_month" between 1 and 12 and "birth_day" between 1 and 31));
