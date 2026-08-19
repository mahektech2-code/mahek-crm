-- Provision only. Nothing is classified, nothing is created, nothing moves.
--
-- `customers.third_party` is a mark somebody applies, not a kind the record
-- becomes. It defaults to false on all 1,079 existing rows, so the day this
-- lands every account behaves exactly as it did the day before — the queue, the
-- targets and the lead book are untouched until a manager ticks something.
--
-- It is deliberately NOT a third value of `customer_kind`. That enum is
-- exclusive and this is not: we may bill a shop directly, and an account we
-- invoiced last month is still a shop we deliver to. Keeping it out of the enum
-- also avoids the Postgres rule that a value added to a type cannot be USED in
-- the transaction that adds it — drizzle-kit applies every pending migration in
-- one, so a mark inside the enum could never be backfilled by a later file.
--
-- `orders.delivery_customer_id` is where the goods went when that is not where
-- the bill went. NULL means they went to the billing party, which is true of
-- every one of the 20,616 rows already stored, so no row changes meaning.
alter table "customers" add column "third_party" boolean default false not null;
--> statement-breakpoint
alter table "orders" add column "delivery_customer_id" text;
--> statement-breakpoint
alter table "orders" add constraint "orders_delivery_customer_id_customers_id_fk"
  foreign key ("delivery_customer_id") references "public"."customers"("id")
  on delete no action on update no action;
--> statement-breakpoint
create index "customers_third_party_idx" on "customers" ("third_party");
--> statement-breakpoint
create index "orders_delivery_customer_idx" on "orders" ("delivery_customer_id");
