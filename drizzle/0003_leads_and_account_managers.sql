CREATE TYPE "public"."customer_kind" AS ENUM('lead', 'customer');--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "kind" "customer_kind" DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "lead_source" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "sales_am_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "back_office_am_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_sales_am_id_users_id_fk" FOREIGN KEY ("sales_am_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_back_office_am_id_users_id_fk" FOREIGN KEY ("back_office_am_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Backfill. Every existing record is a customer, and its sales account manager
-- is whoever already owned it — so scope resolves to exactly what it did
-- yesterday and no list changes on the day this ships. Only records created
-- from here on can be leads.
UPDATE customers SET kind = 'customer' WHERE kind IS NULL;--> statement-breakpoint
UPDATE customers SET sales_am_id = owner_id WHERE sales_am_id IS NULL;--> statement-breakpoint
-- A customer that has genuinely never ordered is a lead by definition. This is
-- the one place the migration reclassifies rather than preserves, because
-- calling them a customer would put a purchase cycle and a monthly target on a
-- record that has neither.
UPDATE customers SET kind = 'lead', sales_am_id = NULL, back_office_am_id = NULL
 WHERE last_order_date IS NULL
   AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = customers.id);
