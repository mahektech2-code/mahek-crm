-- ERP phase 6: unusual-activity alerts and the AI features' records
-- (AI PRD §5 and §10).

-- An alert names the records behind it. The same condition on the same record
-- never raises two open alerts: the partial unique index is that rule.
CREATE TABLE IF NOT EXISTS "erp_alerts" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  -- The condition's identity: kind-specific, e.g. the purchase id.
  "subject" text NOT NULL,
  "screen" text NOT NULL,
  "record_ids" text[] DEFAULT '{}' NOT NULL,
  "power" text,
  "values" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "explanation" text NOT NULL,
  "status" text DEFAULT 'Open' NOT NULL,
  "note" text,
  "raised_at" timestamp with time zone DEFAULT now() NOT NULL,
  "acknowledged_at" timestamp with time zone,
  "acknowledged_by_id" text REFERENCES "users"("id"),
  "resolved_at" timestamp with time zone,
  "resolved_by_id" text REFERENCES "users"("id"),
  "resolve_reason" text,
  CONSTRAINT "erp_alerts_status_check" CHECK ("status" in ('Open', 'Acknowledged', 'Resolved'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_alerts_open_key" ON "erp_alerts" ("kind", "subject") WHERE "status" <> 'Resolved';
CREATE INDEX IF NOT EXISTS "erp_alerts_status_idx" ON "erp_alerts" ("status", "raised_at");

-- Every AI suggestion and what the person did with it: the audit trail and
-- the only honest measure of whether a feature works.
CREATE TABLE IF NOT EXISTS "erp_ai_suggestions" (
  "id" text PRIMARY KEY NOT NULL,
  "feature" text NOT NULL,
  "record_type" text,
  "record_id" text,
  "input_ref" text,
  "proposed" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "confidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "outcome" text DEFAULT 'pending' NOT NULL,
  "final" jsonb,
  "served_by" text,
  "user_id" text REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone,
  CONSTRAINT "erp_ai_suggestions_outcome_check" CHECK ("outcome" in ('pending', 'accepted', 'edited', 'rejected'))
);
CREATE INDEX IF NOT EXISTS "erp_ai_suggestions_feature_idx" ON "erp_ai_suggestions" ("feature", "created_at");

CREATE TABLE IF NOT EXISTS "erp_order_inbox" (
  "id" text PRIMARY KEY NOT NULL,
  "source" text DEFAULT 'paste' NOT NULL,
  "sender" text,
  "customer_id" text REFERENCES "customers"("id"),
  "text" text NOT NULL,
  "draft" jsonb,
  "status" text DEFAULT 'New' NOT NULL,
  "order_no" integer,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone,
  "decided_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_order_inbox_status_check" CHECK ("status" in ('New', 'Converted', 'Not an order', 'Duplicate'))
);

-- The owner's daily paragraph, one per day.
CREATE TABLE IF NOT EXISTS "erp_digests" (
  "day" date PRIMARY KEY NOT NULL,
  "text" text NOT NULL,
  "served_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
