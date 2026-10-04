-- Customers somebody has marked as needing attention to grow into top
-- customers — the Focus customers tab of Monthly targets. One shared row per
-- customer; who may see it is the customer's scope, decided when it is read.
CREATE TABLE IF NOT EXISTS "focus_customers" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
	"added_by_id" text REFERENCES "users"("id") ON DELETE SET NULL,
	"note" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "focus_customers_customer_key" ON "focus_customers" ("customer_id");
