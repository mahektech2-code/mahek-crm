-- The Top customers report, generated on the 1st of every month at 10:00 IST
-- for three spans — 3, 6 and 12 whole calendar months ending with the month
-- just finished. A snapshot, not a cache: nothing rebuilds a past month, so a
-- figure read out in a review stays the figure. Who may see a row is decided
-- when it is read, from the seats as they stand then.
CREATE TABLE IF NOT EXISTS "top_customer_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"span_months" integer NOT NULL,
	"from_month" text NOT NULL,
	"to_month" text NOT NULL,
	"total_paise" bigint NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "top_customer_reports_key" ON "top_customer_reports" ("month", "span_months");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "top_customer_report_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL REFERENCES "top_customer_reports"("id") ON DELETE CASCADE,
	"customer_id" text NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
	"orders" integer NOT NULL,
	"value_paise" bigint NOT NULL,
	"months" jsonb NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "top_customer_report_rows_key" ON "top_customer_report_rows" ("report_id", "customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "top_customer_report_rows_value_idx" ON "top_customer_report_rows" ("report_id", "value_paise");
