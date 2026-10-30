-- PRICE BOOKS — one book per audience, edited in place through dated changes.
--
-- A BOOK IS A LINEAGE. Every version of a price list that superseded another
-- belongs to the book its first version started, so "Mumbai Paid" is one book
-- however many months it has been revised. `book_id` is that first version's
-- id, kept on every row by a trigger so no write path has to remember it: a
-- list inserted on its own starts a book, a version inherits its predecessor's,
-- and a draft published to supersede a list joins that list's book.
ALTER TABLE "price_lists" ADD COLUMN IF NOT EXISTS "book_id" text;
--> statement-breakpoint
WITH RECURSIVE chain AS (
  SELECT l."id", l."id" AS "root" FROM "price_lists" l WHERE l."supersedes_id" IS NULL
  UNION ALL
  SELECT c."id", chain."root" FROM "price_lists" c JOIN chain ON c."supersedes_id" = chain."id"
)
UPDATE "price_lists" l SET "book_id" = chain."root" FROM chain WHERE chain."id" = l."id" AND l."book_id" IS NULL;
--> statement-breakpoint
UPDATE "price_lists" SET "book_id" = "id" WHERE "book_id" IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION price_list_book_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."supersedes_id" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."supersedes_id" IS DISTINCT FROM OLD."supersedes_id") THEN
    NEW."book_id" := coalesce((SELECT p."book_id" FROM "price_lists" p WHERE p."id" = NEW."supersedes_id"), NEW."book_id", NEW."id");
  ELSIF NEW."book_id" IS NULL THEN
    NEW."book_id" := NEW."id";
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "price_lists_book_id" ON "price_lists";
--> statement-breakpoint
CREATE TRIGGER "price_lists_book_id" BEFORE INSERT OR UPDATE OF "supersedes_id", "book_id" ON "price_lists"
  FOR EACH ROW EXECUTE FUNCTION price_list_book_id();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_lists_book_idx" ON "price_lists" ("book_id", "version");
--> statement-breakpoint

-- A CHANGE: edits on a draft copy of the book's newest revision, checked,
-- approved by somebody else, and published on its go-live date. The draft IS a
-- price list (status draft, superseding the base revision), so every existing
-- rule about versions, scopes and the supersede date still applies to it.
CREATE TABLE IF NOT EXISTS "price_changes" (
  "id" text PRIMARY KEY NOT NULL,
  "book_id" text NOT NULL,
  "base_list_id" text REFERENCES "price_lists"("id"),
  "draft_list_id" text NOT NULL REFERENCES "price_lists"("id"),
  "status" text DEFAULT 'draft' NOT NULL,
  "title" text,
  "reason" text,
  "source" text DEFAULT 'editor' NOT NULL,
  "source_document_id" text,
  "restored_from_list_id" text,
  "maker_id" text NOT NULL REFERENCES "users"("id"),
  "go_live" date,
  "submitted_at" timestamp with time zone,
  "approver_id" text REFERENCES "users"("id"),
  "approved_at" timestamp with time zone,
  "needs_second" boolean DEFAULT false NOT NULL,
  "second_approver_id" text REFERENCES "users"("id"),
  "second_approved_at" timestamp with time zone,
  "approver_note" text,
  "send_back_reason" text,
  "notify" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "checks" jsonb,
  "checked_at" timestamp with time zone,
  "checked_hash" text,
  "acks" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "summary" jsonb,
  "cancelled_at" timestamp with time zone,
  "cancelled_by_id" text REFERENCES "users"("id"),
  "cancel_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "price_changes_status_check" CHECK ("status" in ('draft', 'submitted', 'sent_back', 'approved', 'cancelled')),
  CONSTRAINT "price_changes_source_check" CHECK ("source" in ('editor', 'import', 'restore', 'instruction')),
  -- Maker and approver differing is enforced in the action, because the desk
  -- may switch it off (pricing.changes.makerChecker) when one person runs it.
  -- Two approvers being two people is not a setting.
  CONSTRAINT "price_changes_second_differs" CHECK ("second_approver_id" IS NULL OR "second_approver_id" <> "approver_id"),
  CONSTRAINT "price_changes_send_back_reason" CHECK ("status" <> 'sent_back' OR length(btrim(coalesce("send_back_reason", ''))) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_changes_draft_key" ON "price_changes" ("draft_list_id");
--> statement-breakpoint
-- One open change per book: two would each claim to be the next revision.
CREATE UNIQUE INDEX IF NOT EXISTS "price_changes_open_key" ON "price_changes" ("book_id") WHERE "status" in ('draft', 'submitted', 'sent_back');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_changes_status_idx" ON "price_changes" ("status", "updated_at");
--> statement-breakpoint

-- Who did what to a change, append-only.
CREATE TABLE IF NOT EXISTS "price_change_events" (
  "id" text PRIMARY KEY NOT NULL,
  "change_id" text NOT NULL REFERENCES "price_changes"("id") ON DELETE CASCADE,
  "book_id" text NOT NULL,
  "kind" text NOT NULL,
  "actor_id" text REFERENCES "users"("id"),
  "note" text,
  "detail" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_change_events_change_idx" ON "price_change_events" ("change_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_change_events_book_idx" ON "price_change_events" ("book_id", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION price_change_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'price_change_events is append-only';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "price_change_events_no_update" ON "price_change_events";
--> statement-breakpoint
CREATE TRIGGER "price_change_events_no_update" BEFORE UPDATE ON "price_change_events"
  FOR EACH ROW EXECUTE FUNCTION price_change_events_append_only();
--> statement-breakpoint

-- Every AI answer about prices, kept with what it was about so it can be read
-- back later. AI never writes a price: these rows are advice and nothing reads
-- them to decide anything.
CREATE TABLE IF NOT EXISTS "price_ai_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "subject_kind" text NOT NULL,
  "subject_id" text NOT NULL,
  "feature" text NOT NULL,
  "provider" text NOT NULL,
  "model" text,
  "ok" boolean DEFAULT false NOT NULL,
  "output" jsonb,
  "error" text,
  "ms" integer,
  "created_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_ai_runs_subject_idx" ON "price_ai_runs" ("subject_kind", "subject_id", "created_at");
--> statement-breakpoint

-- AN OVERRIDE: one shop × one product × dates, with an optional condition.
-- It is applied through the shop's agreed-prices list (kind = 'agreed'), which
-- already layers over the shop's book per product — so every reader that
-- prices a shop (CRM, ERP, handset, variance) sees it with no change of its
-- own. The override row is what says WHEN: `price-overrides-sync` publishes a
-- new revision of the agreed list on the day one starts or ends, so history
-- stays explainable.
CREATE TABLE IF NOT EXISTS "price_overrides" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL REFERENCES "customers"("id"),
  "product_id" text NOT NULL REFERENCES "products"("id"),
  "rate_ex_gst_paise" bigint NOT NULL,
  "rate_incl_gst_paise" bigint NOT NULL,
  "gst_bp" integer DEFAULT 1800 NOT NULL,
  "valid_from" date NOT NULL,
  "valid_to" date,
  "min_cans_per_month" integer,
  "request_id" text,
  "agreed_list_id" text,
  "note" text,
  "created_by_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cancelled_at" timestamp with time zone,
  "cancelled_by_id" text REFERENCES "users"("id"),
  "cancel_reason" text,
  "reminded_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "price_overrides_dates" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
  CONSTRAINT "price_overrides_positive" CHECK ("rate_ex_gst_paise" > 0),
  CONSTRAINT "price_overrides_min_cans" CHECK ("min_cans_per_month" IS NULL OR "min_cans_per_month" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_overrides_customer_idx" ON "price_overrides" ("customer_id", "product_id", "valid_from");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_overrides_dates_idx" ON "price_overrides" ("valid_from", "valid_to");
--> statement-breakpoint

-- What the morning check found over the live books, one row per finding per day.
CREATE TABLE IF NOT EXISTS "price_book_findings" (
  "id" text PRIMARY KEY NOT NULL,
  "run_day" date NOT NULL,
  "book_id" text,
  "list_id" text,
  "product_id" text,
  "kind" text NOT NULL,
  "severity" text DEFAULT 'medium' NOT NULL,
  "message" text NOT NULL,
  "money_paise" bigint,
  "detail" jsonb,
  "dismissed_at" timestamp with time zone,
  "dismissed_by_id" text REFERENCES "users"("id"),
  "dismiss_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "price_book_findings_severity_check" CHECK ("severity" in ('high', 'medium', 'low'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_book_findings_key" ON "price_book_findings" ("run_day", coalesce("list_id", ''), coalesce("product_id", ''), "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_book_findings_day_idx" ON "price_book_findings" ("run_day", "severity");
