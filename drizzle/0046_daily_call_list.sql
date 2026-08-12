-- The day's call list, settled once and read all day.
--
-- `queue_snapshots` recorded who was in each queue when the day opened, so the
-- screen could say how many rows carried over. It becomes the list itself: the
-- first read of a business day builds it and writes it here, and every read
-- after that works from these rows.
--
-- DROPPED AND RECREATED rather than altered, for two reasons. The primary key
-- has to change — it was (day, customer), and a customer now legitimately
-- appears on two lists, their sales manager's and their back office
-- manager's — and every existing row is a cache of a past day that nothing
-- reads except a carried-over count. The cost of losing them is that one
-- morning's comparison says "we do not know" instead of a number, which is
-- what that screen already shows when there is nothing to compare against.
DROP TABLE IF EXISTS "queue_snapshots";

CREATE TABLE "queue_snapshots" (
  "day" date NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "customer_id" text NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "score" integer NOT NULL DEFAULT 0,
  "reasons" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "rank" integer NOT NULL DEFAULT 0,
  "generated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "queue_snapshots_pkey" PRIMARY KEY ("day", "user_id", "customer_id")
);
--> statement-breakpoint
CREATE INDEX "queue_snapshots_day_idx" ON "queue_snapshots" ("day");
--> statement-breakpoint
CREATE INDEX "queue_snapshots_user_day_idx" ON "queue_snapshots" ("user_id", "day");
