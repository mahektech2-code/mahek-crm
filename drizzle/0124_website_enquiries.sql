-- A visitor's enquiry — from the website today, from Instagram, WhatsApp or
-- IndiaMART tomorrow. `source` says where it came from; `workspace` says
-- which app owns it, and it is always `enquiries` for what this table holds.
--
-- Its own identity, not a customer or a lead: the raw submission, the stage
-- somebody is working it through, who has it — none of that has a home on
-- `customers`, and folding it in would repeat the mistake `mbos_leads` made
-- before it was abandoned. Once a person is identified behind it, this
-- points at a real `customers` row instead of copying their details again.
create type "public"."enquiry_priority" as enum('low', 'normal', 'high', 'urgent');
--> statement-breakpoint
create type "public"."enquiry_stage" as enum('new', 'contacted', 'follow_up', 'qualified', 'converted', 'closed');
--> statement-breakpoint
create table "enquiries" (
	"id" text primary key not null,
	"workspace" "app_id" default 'enquiries' not null,
	"customer_id" text,
	"source" text not null,
	"source_form" text,
	"raw_submission" jsonb not null,
	"stage" "enquiry_stage" default 'new' not null,
	"priority" "enquiry_priority" default 'normal' not null,
	"assigned_to_id" text,
	"received_at" timestamp with time zone not null,
	"external_ref" text,
	"created_at" timestamp with time zone default now() not null,
	"updated_at" timestamp with time zone default now() not null,
	"created_by_id" text,
	"updated_by_id" text
);
--> statement-breakpoint
-- The enquiry's own visible business timeline — received, viewed, assigned,
-- contacted, a note, a stage change. Kept apart from `audit_log`: that is
-- the compliance record of which field changed under which authority, this
-- is the story a person reads to understand what happened to the enquiry,
-- the same split `complaint_status_history` already draws for complaints.
create table "enquiry_activity" (
	"id" text primary key not null,
	"enquiry_id" text not null,
	"kind" text not null,
	"at" timestamp with time zone default now() not null,
	"actor_user_id" text,
	"note" text,
	"meta" jsonb
);
--> statement-breakpoint
-- One enquiry may produce more than one order over its life, so a single
-- `linkedOrderId` on `enquiries` could only ever name one — this is a proper
-- join instead. Deleting either side removes only the LINK: an enquiry and
-- an order are each real independently of whether the other still exists.
create table "enquiry_orders" (
	"id" text primary key not null,
	"enquiry_id" text not null,
	"order_id" text not null,
	"created_at" timestamp with time zone default now() not null,
	"created_by_id" text
);
--> statement-breakpoint
-- Which enquiry a reminder follows up, where there is one. One customer can
-- have more than one open enquiry, so `customer_id` alone cannot say which
-- of them a reminder is for. Null for every reminder that has nothing to do
-- with an enquiry, which is most of them.
alter table "reminders" add column "enquiry_id" text;
--> statement-breakpoint
alter table "enquiries" add constraint "enquiries_customer_id_customers_id_fk" foreign key ("customer_id") references "public"."customers"("id") on delete set null on update no action;
--> statement-breakpoint
alter table "enquiries" add constraint "enquiries_assigned_to_id_users_id_fk" foreign key ("assigned_to_id") references "public"."users"("id") on delete no action on update no action;
--> statement-breakpoint
alter table "enquiry_activity" add constraint "enquiry_activity_enquiry_id_enquiries_id_fk" foreign key ("enquiry_id") references "public"."enquiries"("id") on delete cascade on update no action;
--> statement-breakpoint
alter table "enquiry_activity" add constraint "enquiry_activity_actor_user_id_users_id_fk" foreign key ("actor_user_id") references "public"."users"("id") on delete no action on update no action;
--> statement-breakpoint
alter table "enquiry_orders" add constraint "enquiry_orders_enquiry_id_enquiries_id_fk" foreign key ("enquiry_id") references "public"."enquiries"("id") on delete cascade on update no action;
--> statement-breakpoint
alter table "enquiry_orders" add constraint "enquiry_orders_order_id_orders_id_fk" foreign key ("order_id") references "public"."orders"("id") on delete cascade on update no action;
--> statement-breakpoint
alter table "enquiry_orders" add constraint "enquiry_orders_created_by_id_users_id_fk" foreign key ("created_by_id") references "public"."users"("id") on delete no action on update no action;
--> statement-breakpoint
alter table "reminders" add constraint "reminders_enquiry_id_enquiries_id_fk" foreign key ("enquiry_id") references "public"."enquiries"("id") on delete set null on update no action;
--> statement-breakpoint
create index "enquiries_workspace_stage_idx" on "enquiries" using btree ("workspace","stage");
--> statement-breakpoint
create index "enquiries_assigned_idx" on "enquiries" using btree ("workspace","assigned_to_id");
--> statement-breakpoint
create index "enquiries_priority_idx" on "enquiries" using btree ("workspace","priority");
--> statement-breakpoint
create index "enquiries_received_idx" on "enquiries" using btree ("received_at");
--> statement-breakpoint
create index "enquiries_customer_idx" on "enquiries" using btree ("customer_id");
--> statement-breakpoint
-- The Unassigned view, and only that view — an enquiry with an assignee
-- never touches this.
create index "enquiries_unassigned_idx" on "enquiries" using btree ("workspace","received_at") where assigned_to_id is null;
--> statement-breakpoint
create unique index "enquiries_external_ref_key" on "enquiries" using btree ("external_ref");
--> statement-breakpoint
create index "enquiry_activity_enquiry_idx" on "enquiry_activity" using btree ("enquiry_id","at" desc);
--> statement-breakpoint
create unique index "enquiry_orders_pair_key" on "enquiry_orders" using btree ("enquiry_id","order_id");
--> statement-breakpoint
create index "enquiry_orders_order_idx" on "enquiry_orders" using btree ("order_id");
--> statement-breakpoint
create index "reminders_enquiry_idx" on "reminders" using btree ("enquiry_id");
