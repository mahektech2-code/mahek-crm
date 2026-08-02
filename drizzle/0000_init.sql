CREATE TYPE "public"."app_id" AS ENUM('crm', 'field', 'orders', 'people', 'reports', 'admin');--> statement-breakpoint
CREATE TYPE "public"."bill_status" AS ENUM('Unpaid', 'Partly paid', 'Paid');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('Call', 'WhatsApp', 'Visit');--> statement-breakpoint
CREATE TYPE "public"."complaint_status" AS ENUM('Open', 'In progress', 'Resolved', 'Closed');--> statement-breakpoint
CREATE TYPE "public"."connection" AS ENUM('Connected', 'Missed', 'Not reachable', 'Busy', 'Wrong number');--> statement-breakpoint
CREATE TYPE "public"."customer_status" AS ENUM('Active', 'Slow payer', 'Inactive', 'New');--> statement-breakpoint
CREATE TYPE "public"."dest_kind" AS ENUM('personal', 'group');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('Queued', 'Copied', 'Sent', 'Delivered', 'Read', 'Failed', 'Cancelled');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('open', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('telecaller', 'manager', 'admin');--> statement-breakpoint
CREATE TYPE "public"."send_mode" AS ENUM('manual', 'connected');--> statement-breakpoint
CREATE TABLE "app_access" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"app" "app_id" NOT NULL,
	"granted_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"signed_in_at" timestamp with time zone NOT NULL,
	"signed_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"detail" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"id" text PRIMARY KEY NOT NULL,
	"bill_no" text NOT NULL,
	"customer_id" text NOT NULL,
	"bill_date" date NOT NULL,
	"due_date" date NOT NULL,
	"amount" bigint NOT NULL,
	"paid" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "complaint_events" (
	"id" text PRIMARY KEY NOT NULL,
	"complaint_id" text NOT NULL,
	"note" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "complaints" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"logged_by_id" text NOT NULL,
	"assigned_to" text DEFAULT 'Operations' NOT NULL,
	"status" "complaint_status" DEFAULT 'Open' NOT NULL,
	"resolution_note" text,
	"customer_told" boolean DEFAULT false NOT NULL,
	"logged_on" date NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"contact_person" text NOT NULL,
	"phone" text NOT NULL,
	"city" text NOT NULL,
	"owner_id" text,
	"status" "customer_status" DEFAULT 'Active' NOT NULL,
	"gstin" text,
	"credit_term_days" integer DEFAULT 30 NOT NULL,
	"route" text,
	"cycle_days" integer DEFAULT 30 NOT NULL,
	"last_order_date" date,
	"last_order_value" bigint DEFAULT 0 NOT NULL,
	"last_contact_at" timestamp with time zone,
	"outstanding" bigint DEFAULT 0 NOT NULL,
	"avg_order_value" bigint DEFAULT 0 NOT NULL,
	"orders_6m" integer DEFAULT 0 NOT NULL,
	"pays_in_days" integer DEFAULT 30 NOT NULL,
	"slow_payer" boolean DEFAULT false NOT NULL,
	"whatsapp_group_name" text,
	"whatsapp_dest" "dest_kind" DEFAULT 'personal' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"deactivation_requested" boolean DEFAULT false NOT NULL,
	"deactivation_reason" text,
	"customer_since" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eod_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"body" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "help_articles" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"role" text DEFAULT 'Telecaller' NOT NULL,
	"is_script" boolean DEFAULT false NOT NULL,
	"script_body" text,
	"body" text NOT NULL,
	"updated_on" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel" "channel" DEFAULT 'Call' NOT NULL,
	"connection" "connection",
	"outcome" text,
	"note" text,
	"produced" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"kind" text DEFAULT 'info' NOT NULL,
	"href" text,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"user_id" text NOT NULL,
	"product" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"value" bigint NOT NULL,
	"expected_dispatch" date,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"bill_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"mode" text DEFAULT 'Bank transfer' NOT NULL,
	"reference" text,
	"received_on" date NOT NULL,
	"recorded_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promises" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"user_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"promised_by" date NOT NULL,
	"note" text,
	"kept" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_items" (
	"id" text PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"customer_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"reason" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"worked" boolean DEFAULT false NOT NULL,
	"skipped" boolean DEFAULT false NOT NULL,
	"held_back_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"user_id" text NOT NULL,
	"due_date" date NOT NULL,
	"note" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" "reminder_status" DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"period" text NOT NULL,
	"amount" bigint NOT NULL,
	"is_default" boolean DEFAULT true NOT NULL,
	"set_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"password_hash" text NOT NULL,
	"role" "role" DEFAULT 'telecaller' NOT NULL,
	"initials" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"template_id" text,
	"template_name" text,
	"body" text NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"destination" text NOT NULL,
	"dest_kind" "dest_kind" DEFAULT 'personal' NOT NULL,
	"mode" "send_mode" DEFAULT 'manual' NOT NULL,
	"status" "message_status" DEFAULT 'Queued' NOT NULL,
	"sent_by_id" text NOT NULL,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_replies" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"message" text NOT NULL,
	"actioned" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"template_id" text,
	"filter_key" text NOT NULL,
	"recipients" jsonb NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"finished_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"body" text NOT NULL,
	"applies_to" "dest_kind" DEFAULT 'personal' NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_access" ADD CONSTRAINT "app_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_access" ADD CONSTRAINT "app_access_granted_by_id_users_id_fk" FOREIGN KEY ("granted_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_events" ADD CONSTRAINT "complaint_events_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "public"."complaints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_logged_by_id_users_id_fk" FOREIGN KEY ("logged_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eod_reports" ADD CONSTRAINT "eod_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_set_by_id_users_id_fk" FOREIGN KEY ("set_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_template_id_wa_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."wa_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_sent_by_id_users_id_fk" FOREIGN KEY ("sent_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_replies" ADD CONSTRAINT "wa_replies_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_runs" ADD CONSTRAINT "wa_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_runs" ADD CONSTRAINT "wa_runs_template_id_wa_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."wa_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_access_user_app_key" ON "app_access" USING btree ("user_id","app");--> statement-breakpoint
CREATE INDEX "app_access_user_idx" ON "app_access" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_user_day_key" ON "attendance" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "attendance_day_idx" ON "attendance" USING btree ("day");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bills_no_key" ON "bills" USING btree ("bill_no");--> statement-breakpoint
CREATE INDEX "bills_customer_idx" ON "bills" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "complaints_customer_idx" ON "complaints" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customers_owner_idx" ON "customers" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "customers" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "eod_user_day_key" ON "eod_reports" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "interactions_customer_idx" ON "interactions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "interactions_user_time_idx" ON "interactions" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "payments_customer_idx" ON "payments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "promises_customer_idx" ON "promises" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_day_customer_key" ON "queue_items" USING btree ("day","customer_id","owner_id");--> statement-breakpoint
CREATE INDEX "queue_day_owner_idx" ON "queue_items" USING btree ("day","owner_id");--> statement-breakpoint
CREATE INDEX "reminders_user_due_idx" ON "reminders" USING btree ("user_id","due_date");--> statement-breakpoint
CREATE INDEX "reminders_customer_idx" ON "reminders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "targets_customer_period_key" ON "targets" USING btree ("customer_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "wa_messages_customer_idx" ON "wa_messages" USING btree ("customer_id");