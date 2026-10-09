-- THE WEBSITE CMS (0240) — ADDITIVE ONLY.
--
-- What mahekindia.com shows, kept here so it can be edited, previewed and
-- published from MahekOne instead of changed in the website's code.
--
-- One row is one piece of content: a product, an industry, a gallery tile, a
-- job, a testimonial, a milestone, a page's copy, an SEO entry, the menus, the
-- site settings. `kind` says which, `slug` is its identity inside that kind
-- (a product's web address; a fixed word such as 'site' for the two one-row
-- kinds), and `data` is the validated shape for that kind.
--
-- TWO COPIES, ON PURPOSE. `data` is the working copy — what the editor shows
-- and what a preview renders. `published_data` is the snapshot the public site
-- reads, and it is only ever written by a publish. Saving never changes what is
-- live; publishing never loses what was typed. `version` counts saves and
-- `published_version` is the save that was published, so "has unpublished
-- changes" is `version <> published_version` with no JSON comparison. The live
-- ORDER of a list is its own snapshot (`published_sort`) for the same reason:
-- dragging a product up in the editor must not reorder the live site until the
-- list is published.
--
-- STATES. draft = not live (never published, or unpublished); published = live;
-- archived = retired, not live, kept. Nothing here is deleted by the app except
-- a draft that was never published.
--
-- Media bytes live in the existing file store (`lib/storage.ts`, Postgres or
-- S3); `website_media` is the catalogue of them. A `site` row is a file that
-- already ships inside the website's own image (`site_path`), listed so the
-- pickers can offer it; the CMS never writes or deletes those.
--
-- Nothing in this migration touches an existing table, and it writes no rows.
CREATE TYPE "public"."website_content_state" AS ENUM ('draft', 'published', 'archived');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "website_content" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "slug" text NOT NULL,
  "sort" integer NOT NULL DEFAULT 0,
  "state" "website_content_state" NOT NULL DEFAULT 'draft',
  "data" jsonb NOT NULL,
  "published_data" jsonb,
  "version" integer NOT NULL DEFAULT 1,
  "published_version" integer,
  "published_sort" integer,
  "published_at" timestamp with time zone,
  "published_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "website_content_live_has_snapshot" CHECK (
    ("state" = 'published') = ("published_data" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "website_content_kind_slug_key" ON "website_content" ("kind", "slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_content_kind_state_sort_idx" ON "website_content" ("kind", "state", "sort");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "website_media" (
  "id" text PRIMARY KEY NOT NULL,
  "source" text NOT NULL,
  "filename" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL DEFAULT 0,
  "content_hash" text,
  "stored_ref" text,
  "site_path" text,
  "alt" text NOT NULL DEFAULT '',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "uploaded_by_id" text REFERENCES "users"("id"),
  "deleted_at" timestamp with time zone,
  "deleted_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "website_media_source_check" CHECK ("source" IN ('upload', 'site')),
  CONSTRAINT "website_media_where_check" CHECK (
    ("source" = 'upload' AND "stored_ref" IS NOT NULL) OR ("source" = 'site' AND "site_path" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "website_media_site_path_key" ON "website_media" ("site_path") WHERE "site_path" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_media_created_idx" ON "website_media" ("created_at" DESC);
--> statement-breakpoint
-- What was done, by whom, and whether the live site actually refreshed. A publish
-- that committed but whose refresh failed leaves a 'refresh' row with ok = false
-- — it is never silently a success.
CREATE TABLE IF NOT EXISTS "website_publish_log" (
  "id" text PRIMARY KEY NOT NULL,
  "at" timestamp with time zone NOT NULL DEFAULT now(),
  "actor_id" text REFERENCES "users"("id"),
  "action" text NOT NULL,
  "kind" text,
  "slug" text,
  "content_id" text,
  "ok" boolean NOT NULL DEFAULT true,
  "detail" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_publish_log_at_idx" ON "website_publish_log" ("at" DESC);
