-- The days nobody is expected to work.
--
-- The Manager Console design has a Holidays screen and MahekOne had nowhere to
-- put one. It is a small table and it earns its place: attendance reads as
-- "absent" for everybody on Ganesh Chaturthi otherwise, leave is measured in
-- working days that nothing defines, and a journey plan will cheerfully route
-- somebody into a shut market.
--
-- `scope` is free text rather than a foreign key to a beat. A holiday is
-- regional in a way the territory model cannot express — "Nagpur East and
-- Nagpur West" is two beats, "all beats" is every beat there will ever be, and
-- a join table would have to be maintained every time a beat is renamed. Null
-- means everywhere.
CREATE TABLE IF NOT EXISTS "mbos_holidays" (
  "id" text PRIMARY KEY NOT NULL,
  "on_date" date NOT NULL,
  "name" text NOT NULL,
  "scope" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id" text
);

-- One entry per day per scope. Two rows for one day is two answers to "is
-- anybody working", and the screen that reads it would have to pick one.
CREATE UNIQUE INDEX IF NOT EXISTS "mbos_holidays_day_scope_key"
  ON "mbos_holidays" ("on_date", COALESCE("scope", ''));

CREATE INDEX IF NOT EXISTS "mbos_holidays_date_idx" ON "mbos_holidays" ("on_date");
