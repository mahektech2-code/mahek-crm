-- Who bills the shop we deliver to.
--
-- `customers.third_party` said an account is served through a distributor and
-- could not say WHICH — so the mark was an assertion with nothing behind it,
-- and the only way to find the distributor was to read the order history and
-- infer it. This is that fact, stated by a person: one row per shop per
-- distributor, at least one for every marked account, and the distributor is
-- always an account we bill directly.
--
-- A table rather than a column on `customers`, because the answer is a LIST.
-- A shop on a boundary is served by two distributors and picking one of them
-- to store would make the other unrecordable — which is how the first version
-- of this would have been wrong for exactly the accounts that need it most.
--
-- `is_primary` is who serves it usually, and there is at most one: the partial
-- unique index below is what makes that true, rather than a rule in a service
-- that a second writer would not know about. It is nullable in effect — a shop
-- with two equal distributors names no primary, which is a real answer.
--
-- Deleting a customer takes its links with it in both directions. A link to a
-- record that is gone is a distributor nobody can open, and the panel that
-- draws it would show a blank name where the whole point is a name.
create table "customer_distributors" (
  "id" text primary key not null,
  "customer_id" text not null,
  "distributor_customer_id" text not null,
  "is_primary" boolean default false not null,
  "note" text,
  "created_at" timestamp with time zone default now() not null,
  "created_by_id" text,
  "updated_at" timestamp with time zone default now() not null,
  "updated_by_id" text,
  constraint "customer_distributors_not_self" check ("customer_id" <> "distributor_customer_id")
);
--> statement-breakpoint
alter table "customer_distributors" add constraint "customer_distributors_customer_id_customers_id_fk"
  foreign key ("customer_id") references "public"."customers"("id") on delete cascade on update no action;
--> statement-breakpoint
alter table "customer_distributors" add constraint "customer_distributors_distributor_customers_id_fk"
  foreign key ("distributor_customer_id") references "public"."customers"("id") on delete cascade on update no action;
--> statement-breakpoint
alter table "customer_distributors" add constraint "customer_distributors_created_by_users_id_fk"
  foreign key ("created_by_id") references "public"."users"("id") on delete no action on update no action;
--> statement-breakpoint
alter table "customer_distributors" add constraint "customer_distributors_updated_by_users_id_fk"
  foreign key ("updated_by_id") references "public"."users"("id") on delete no action on update no action;
--> statement-breakpoint
-- One link per pair. Naming the same distributor twice is a double-click, not
-- a second arrangement, and two identical rows would be counted as two.
create unique index "customer_distributors_pair_key"
  on "customer_distributors" ("customer_id","distributor_customer_id");
--> statement-breakpoint
-- At most one usual distributor per shop, in the database rather than in a
-- service. Two rows both claiming to be the primary is a state no screen can
-- render honestly.
create unique index "customer_distributors_primary_key"
  on "customer_distributors" ("customer_id") where "is_primary";
--> statement-breakpoint
-- "Which shops does this distributor serve" is the question the direct
-- customer's record asks, and it reads this way round.
create index "customer_distributors_distributor_idx"
  on "customer_distributors" ("distributor_customer_id");
