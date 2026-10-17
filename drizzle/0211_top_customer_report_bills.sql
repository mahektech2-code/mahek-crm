-- The Top customers report counts sales bills as well as orders: its columns
-- are now orders, sales and bills PER MONTH, and bills were not stored.
--
-- The reports already generated (October 2026's, built the day the report
-- shipped) carry no bill counts, so they are removed and rebuilt by the next
-- caller: the hourly pass, or the first person to open the tab. That is the
-- one time a generated report is regenerated; it is a snapshot from then on.
ALTER TABLE "top_customer_report_rows" ADD COLUMN IF NOT EXISTS "bills" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DELETE FROM "top_customer_reports";
