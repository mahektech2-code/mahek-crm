-- A sales manager covers a patch, and it is not always the whole country.
--
-- The Manager Console design has a national manager over regional ones —
-- "West and Central", "South", "North and East" — each seeing only their own
-- states. Every read in the console was all-India, which is right for exactly
-- one person and wrong for everybody under them.
--
-- One row per manager per region. **No rows means national**, and that is the
-- load-bearing part: every grant that already exists carries on meaning what
-- it meant, and the console narrows only once somebody has actually said which
-- regions a manager covers. It is the same rule `app_module_access` uses for
-- modules, for the same reason — a permission model that changes what existing
-- rows mean on the day it ships is one nobody can deploy.
--
-- `region` is text and matches `customers.territory_region`. It is not a
-- foreign key because there is no regions table: a region is whatever the
-- customer master says it is, and inventing a second list would give the
-- console a set of regions the book does not use.
CREATE TABLE IF NOT EXISTS "mbos_manager_territories" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "region" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text
);

DO $$ BEGIN
  ALTER TABLE "mbos_manager_territories"
    ADD CONSTRAINT "mbos_manager_territories_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- One row per manager per region. A second is not a wider scope, it is a
-- duplicate, and it would double every count that joins through this.
CREATE UNIQUE INDEX IF NOT EXISTS "mbos_manager_territories_key"
  ON "mbos_manager_territories" ("user_id", "region");
