-- EVERY SPELLING A PERSON HAS CARRIED, pointing at the one employee they are.
--
-- A name is a label and labels change: HR renames somebody, the party sheet
-- goes on spelling them the old way, an import from 2025 spells them a third
-- way. Matching any of those strings against today's name loses the person.
-- So a rename writes the OLD name here, and every place a name has to be
-- turned into a person (a sheet row, an import) resolves through today's
-- names AND these — refusing a spelling that lands on two people.
-- See lib/engines/person-directory.ts.
CREATE TABLE IF NOT EXISTS "person_name_aliases" (
  "id" text PRIMARY KEY NOT NULL,
  "name_key" text NOT NULL,
  "name" text NOT NULL,
  "employee_id" text NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "source" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "person_name_aliases_key_employee" ON "person_name_aliases" ("name_key", "employee_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "person_name_aliases_employee_idx" ON "person_name_aliases" ("employee_id");
