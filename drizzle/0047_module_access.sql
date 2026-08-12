-- Which screens inside an app somebody may open.
--
-- `app_access` grants the CRM. It has never been able to say "the CRM, but not
-- Monthly Targets and not the Sheet import", because the app was the smallest
-- thing that could be granted — so a telecaller given the CRM was given every
-- screen in it.
--
-- The module keys live in `src/lib/modules.ts` and this table holds no labels.
-- A screen's name belongs in one place; a copy of it on every grant row would
-- drift the first time one was renamed.
--
-- NO ROWS FOR AN APP MEANS EVERY MODULE OF IT, and that is why this migration
-- moves nothing. Every grant that exists today keeps meaning exactly what it
-- meant, on every screen, for everybody; a grant narrows only once somebody has
-- unticked something on the access screen. It is also what keeps
-- `npm run app:grant` and the provisioning endpoint honest — neither knows
-- modules exist, and an app granted from a terminal has to open whole rather
-- than open empty.
CREATE TABLE "app_module_access" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "app" "app_id" NOT NULL,
  "module" text NOT NULL,
  "granted_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One row per person per module. The module key already carries its app, so
-- this is the whole of uniqueness; `app` is stored beside it so revoking an app
-- can clear its module rows in one statement.
CREATE UNIQUE INDEX "app_module_access_user_module_key"
  ON "app_module_access" USING btree ("user_id", "module");
--> statement-breakpoint
CREATE INDEX "app_module_access_user_app_idx"
  ON "app_module_access" USING btree ("user_id", "app");
