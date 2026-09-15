-- A reminder is closed by evidence, not by an assertion.
--
-- Until now the only thing that could close one was somebody pressing "Mark
-- done", which records that a button was pressed and nothing about whether the
-- call was made. These two columns say what closed it and name the row that
-- proves it — a call, an order, or a receipt accounts confirmed.
--
-- Nothing is backfilled. Every existing closed reminder keeps a null here,
-- which reads as "closed before we started recording how", and that is the
-- truth about them; writing 'person' across the table would be inventing a
-- fact about work nobody can now check.

CREATE TYPE "public"."reminder_closure_source" AS ENUM('person', 'call', 'order', 'payment');

ALTER TABLE "reminders" ADD COLUMN "closed_by" "reminder_closure_source";
ALTER TABLE "reminders" ADD COLUMN "closed_by_source_id" text;
