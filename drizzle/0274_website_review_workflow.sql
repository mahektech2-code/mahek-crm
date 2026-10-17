-- THE WEBSITE REVIEW WORKFLOW (0274) — ADDITIVE ONLY.
--
-- Who may change which website content, a frozen submission of what they
-- changed, and a reviewer's decision on exactly that content. Nothing here
-- touches `website_content`, `website_media` or `website_publish_log`, and the
-- migration writes no rows except the single settings row below.
--
-- TEXT + CHECK, NOT ENUMS. A value added to a Postgres enum cannot be used in
-- the transaction that adds it, and drizzle runs every pending migration in one.
-- The allowed sets are also stated once in `lib/website-cms/review-status.ts`,
-- which a test compares against these constraints.
--
-- WHAT IS DELIBERATELY NOT HERE. No grant of `website.review` to anybody: it is
-- an explicit-only module and is ticked for a named person on the Access
-- screen. No backfill of assignments: with the enforcement setting off (the
-- default) nobody's existing access changes.

-- Who works which content. `content_id` null = every item of that kind, which
-- is also the only way to cover an item that does not exist yet (a new one).
-- `kind` includes 'media': the library has no per-item record, so a media
-- assignment is by kind only.
CREATE TABLE IF NOT EXISTS "website_assignment" (
  "id" text PRIMARY KEY NOT NULL,
  "employee_id" text NOT NULL REFERENCES "users"("id"),
  "kind" text NOT NULL,
  "content_id" text REFERENCES "website_content"("id") ON DELETE CASCADE,
  "scope_note" text,
  "assigned_by_id" text NOT NULL REFERENCES "users"("id"),
  "assigned_at" timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at" timestamp with time zone,
  "revoked_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "website_assignment_kind_check" CHECK (
    "kind" IN ('product', 'industry', 'gallery', 'job', 'testimonial', 'milestone', 'page', 'seo', 'navigation', 'settings', 'media')
  ),
  CONSTRAINT "website_assignment_revoked_pair" CHECK (
    ("revoked_at" IS NULL) = ("revoked_by_id" IS NULL)
  )
);
--> statement-breakpoint
-- One live assignment per person per scope: assigning twice is one assignment.
CREATE UNIQUE INDEX IF NOT EXISTS "website_assignment_active_key"
  ON "website_assignment" ("employee_id", "kind", COALESCE("content_id", ''))
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_assignment_employee_idx" ON "website_assignment" ("employee_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_assignment_content_idx" ON "website_assignment" ("content_id");
--> statement-breakpoint

-- One submission of changes for review. The status set and its allowed moves
-- are `review-status.ts`; the constraints below are the ones that must hold
-- whatever code writes the row.
CREATE TABLE IF NOT EXISTS "website_change_request" (
  "id" text PRIMARY KEY NOT NULL,
  "submitter_id" text NOT NULL REFERENCES "users"("id"),
  "status" text NOT NULL DEFAULT 'submitted',
  "submitted_at" timestamp with time zone NOT NULL DEFAULT now(),
  "note" text,
  "reviewer_id" text REFERENCES "users"("id"),
  "reviewed_at" timestamp with time zone,
  "reject_reason" text,
  "approved_at" timestamp with time zone,
  "approval_expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by_id" text REFERENCES "users"("id"),
  "published_at" timestamp with time zone,
  "published_by_id" text REFERENCES "users"("id"),
  "resubmission_of" text REFERENCES "website_change_request"("id"),
  CONSTRAINT "website_change_request_status_check" CHECK (
    "status" IN ('submitted', 'approved', 'rejected', 'revoked', 'expired', 'stale', 'published', 'withdrawn')
  ),
  -- The one rule worth enforcing below the application: nobody approves, or
  -- rejects, their own submission.
  CONSTRAINT "website_change_request_not_self_reviewed" CHECK (
    "reviewer_id" IS NULL OR "reviewer_id" <> "submitter_id"
  ),
  CONSTRAINT "website_change_request_reject_has_reason" CHECK (
    "status" <> 'rejected' OR length(btrim(coalesce("reject_reason", ''))) > 0
  ),
  CONSTRAINT "website_change_request_approved_has_expiry" CHECK (
    "status" <> 'approved' OR ("reviewer_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approval_expires_at" IS NOT NULL)
  ),
  CONSTRAINT "website_change_request_published_has_stamp" CHECK (
    "status" <> 'published' OR ("published_at" IS NOT NULL AND "published_by_id" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_change_request_status_idx" ON "website_change_request" ("status", "submitted_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_change_request_submitter_idx" ON "website_change_request" ("submitter_id", "submitted_at" DESC);
--> statement-breakpoint

-- What a submission froze, per item. `proposed_data` is the exact working copy
-- at submission and `proposed_hash` its stable-JSON sha256: publishing compares
-- BOTH the live row's version and this hash, so approval covers only the
-- content that was reviewed. `base_data` is what was live (null = not live: an
-- ADD). `content_id` carries no foreign key on purpose: a request is history,
-- and must outlive a draft that was later deleted.
CREATE TABLE IF NOT EXISTS "website_change_item" (
  "id" text PRIMARY KEY NOT NULL,
  "request_id" text NOT NULL REFERENCES "website_change_request"("id") ON DELETE CASCADE,
  "content_id" text NOT NULL,
  "kind" text NOT NULL,
  "slug" text NOT NULL,
  "action" text NOT NULL,
  "base_version" integer,
  "base_data" jsonb,
  "proposed_data" jsonb NOT NULL,
  "proposed_hash" text NOT NULL,
  "submitted_version" integer NOT NULL,
  "media_before" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "media_after" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Equals `content_id` while this item's request is OPEN (submitted or
  -- approved) and null otherwise. A partial unique index cannot look at another
  -- table's status, so the command keeps this column in step in the same
  -- transaction as every status change — and the index below is what makes two
  -- concurrent submissions of one item impossible rather than merely unlikely.
  "open_content_id" text,
  CONSTRAINT "website_change_item_action_check" CHECK ("action" IN ('add', 'edit')),
  CONSTRAINT "website_change_item_kind_check" CHECK (
    "kind" IN ('product', 'industry', 'gallery', 'job', 'testimonial', 'milestone', 'page', 'seo', 'navigation', 'settings')
  ),
  CONSTRAINT "website_change_item_hash_check" CHECK (length("proposed_hash") = 64),
  CONSTRAINT "website_change_item_add_has_no_base" CHECK (
    ("action" = 'add') = ("base_data" IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "website_change_item_open_key"
  ON "website_change_item" ("open_content_id") WHERE "open_content_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "website_change_item_request_content_key" ON "website_change_item" ("request_id", "content_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_change_item_content_idx" ON "website_change_item" ("content_id");
--> statement-breakpoint

-- WHETHER ASSIGNMENTS ARE ENFORCED. One row, `site`. It is not an
-- `app_settings` key: those are edited by anybody holding `config.write`, and
-- this is a decision Mahek gave to `website.review` holders alone — the same
-- reasoning the WhatsApp switch is its own table. Off by default, so on the
-- day this ships nobody who can edit today loses that.
CREATE TABLE IF NOT EXISTS "website_review_setting" (
  "id" text PRIMARY KEY NOT NULL,
  "enforce_assignments" boolean NOT NULL DEFAULT false,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "website_review_setting_single_row" CHECK ("id" = 'site')
);
--> statement-breakpoint
INSERT INTO "website_review_setting" ("id", "enforce_assignments") VALUES ('site', false) ON CONFLICT ("id") DO NOTHING;
