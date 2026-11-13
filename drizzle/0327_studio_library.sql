-- Studio: the shared template library, finished.
--
-- Three additions, all backward compatible (every new column is nullable and
-- every existing design keeps meaning exactly what it did):
--
--  * archived_by_id — WHO archived a design, so the uploader may restore only
--    what they archived themselves and an approver's archive stays theirs to undo.
--  * source_ref / source_format — the ORIGINAL uploaded JPG, PNG or WebP, kept
--    in file storage beside the normalised background. Designs uploaded before
--    this carry NULL: nothing is backfilled, because the original is gone.
--  * revises_id / revises_version — a DRAFT that is a new version of a
--    published design, and the exact version it was made from. On publish the
--    design keeps its id and moves to the next version and the draft row goes
--    away; a draft whose base is no longer the current version is refused.
--    A partial unique index allows one open new version per design per person.
--
-- studio_design_versions holds every SUPERSEDED version of a design, whole
-- (manifest, copy, placement and the file references), so a poster made from
-- version 1.0.0 draws the same after the design moves to 1.0.1. The current
-- version stays on studio_designs; nothing here rewrites a stored poster.
ALTER TABLE "studio_designs" ADD COLUMN IF NOT EXISTS "archived_by_id" text REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "studio_designs" ADD COLUMN IF NOT EXISTS "source_ref" text;--> statement-breakpoint
ALTER TABLE "studio_designs" ADD COLUMN IF NOT EXISTS "source_format" text;--> statement-breakpoint
ALTER TABLE "studio_designs" ADD COLUMN IF NOT EXISTS "revises_id" text REFERENCES "studio_designs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "studio_designs" ADD COLUMN IF NOT EXISTS "revises_version" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_designs_revises_idx" ON "studio_designs" ("revises_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "studio_designs_one_open_revision" ON "studio_designs" ("revises_id","created_by_id") WHERE "status" = 'draft';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "studio_design_versions" (
	"design_id" text NOT NULL REFERENCES "studio_designs"("id") ON DELETE CASCADE,
	"version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"copy" jsonb,
	"placement" jsonb NOT NULL,
	"background_ref" text NOT NULL,
	"preview_ref" text NOT NULL,
	"source_ref" text,
	"source_format" text,
	"published_by_id" text REFERENCES "users"("id"),
	"published_at" timestamp with time zone,
	"superseded_by_id" text REFERENCES "users"("id"),
	"superseded_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("design_id","version")
);
