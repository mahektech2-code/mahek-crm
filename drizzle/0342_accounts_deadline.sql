-- THE ACCOUNTS DEADLINE (Nov 2026). Something that waits on the ledger desk
-- past its working-hours deadline — an order to approve, a payment to
-- confirm, a credit note or an order change to decide — becomes a row here
-- once, the admins are told, and the accounts team owes a reason (and a time
-- to be reminded) until it is decided. Remarks are append-only.
CREATE TABLE IF NOT EXISTS "accounts_sla_breaches" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('order','payment','credit_note','order_change')),
  "record_id" text NOT NULL,
  "waiting_since" timestamp with time zone NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "detected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "admins_notified_at" timestamp with time zone,
  "escalations" integer DEFAULT 0 NOT NULL,
  "last_escalated_at" timestamp with time zone,
  "acknowledged_by_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "acknowledged_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_sla_breaches_record_key" ON "accounts_sla_breaches" ("kind","record_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_sla_breaches_open_idx" ON "accounts_sla_breaches" ("due_at") WHERE "resolved_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounts_sla_remarks" (
  "id" text PRIMARY KEY NOT NULL,
  "breach_id" text NOT NULL REFERENCES "accounts_sla_breaches"("id") ON DELETE CASCADE,
  "author_id" text NOT NULL REFERENCES "users"("id"),
  "side" text NOT NULL CHECK ("side" IN ('accounts','admin')),
  "body" text NOT NULL CHECK (length(btrim("body")) >= 3),
  "remind_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CHECK ("side" = 'admin' OR "remind_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_sla_remarks_breach_idx" ON "accounts_sla_remarks" ("breach_id","created_at");
