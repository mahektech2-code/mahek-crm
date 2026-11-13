-- Studio: Upload & Bulk Forward.
--
-- A finished poster, uploaded as it is and forwarded unchanged to many
-- recipients. Two new tables and nothing else is touched. MahekOne sends
-- nothing itself: each recipient is a row somebody works through (open the
-- chat, attach, send, say so), and the status says only what a person said.

CREATE TABLE IF NOT EXISTS "studio_forwards" (
  "id" text PRIMARY KEY NOT NULL,
  "created_by_id" text NOT NULL REFERENCES "users"("id"),
  "title" text NOT NULL,
  "source_ref" text NOT NULL,
  "format" text NOT NULL,
  "sha256" text NOT NULL,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "caption" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'draft',
  "started_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "studio_forwards_status" CHECK ("status" in ('draft','started')),
  CONSTRAINT "studio_forwards_format" CHECK ("format" in ('png','jpeg','webp'))
);
CREATE INDEX IF NOT EXISTS "studio_forwards_created_by_idx" ON "studio_forwards" ("created_by_id","created_at");
CREATE INDEX IF NOT EXISTS "studio_forwards_sha_idx" ON "studio_forwards" ("sha256");

CREATE TABLE IF NOT EXISTS "studio_forward_recipients" (
  "id" text PRIMARY KEY NOT NULL,
  "forward_id" text NOT NULL REFERENCES "studio_forwards"("id") ON DELETE CASCADE,
  "customer_id" text REFERENCES "customers"("id") ON DELETE SET NULL,
  "company" text NOT NULL,
  "place" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'pending',
  "opened_at" timestamp with time zone,
  "decided_at" timestamp with time zone,
  "decided_by_id" text REFERENCES "users"("id"),
  "note" text,
  CONSTRAINT "studio_forward_recipients_status" CHECK ("status" in ('pending','opened','sent','skipped'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "studio_forward_recipients_one" ON "studio_forward_recipients" ("forward_id","customer_id");
CREATE INDEX IF NOT EXISTS "studio_forward_recipients_customer_idx" ON "studio_forward_recipients" ("customer_id");
