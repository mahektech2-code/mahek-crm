-- A JOB TEMPLATE is a named shape of access across EVERY app: the apps, the
-- level each is held under, the screens (null = the whole app) and the
-- powers. Unlike an ERP designation it is a STAMP, not a link: applying it
-- widens a person's access to include it and never narrows anything, so an
-- edit to the template moves nobody. See lib/access-templates.ts.
CREATE TABLE IF NOT EXISTS "access_templates" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "shape" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id" text REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "access_templates_name_key" ON "access_templates" (lower("name"));
