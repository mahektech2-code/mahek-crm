CREATE TYPE "public"."app_id" AS ENUM('crm', 'field', 'orders', 'people', 'reports', 'admin');--> statement-breakpoint
CREATE TYPE "public"."bill_status" AS ENUM('unpaid', 'partially_paid', 'paid');--> statement-breakpoint
CREATE TYPE "public"."call_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."call_outcome" AS ENUM('order_placed', 'will_order_later', 'no_requirement_now', 'payment_promised', 'payment_dispute', 'complaint_raised', 'not_reachable', 'call_back_requested', 'refused');--> statement-breakpoint
CREATE TYPE "public"."complaint_category" AS ENUM('delivery', 'product_quality', 'billing', 'pricing', 'service', 'shortage', 'packaging', 'other');--> statement-breakpoint
CREATE TYPE "public"."complaint_status" AS ENUM('open', 'in_progress', 'awaiting_customer', 'resolved', 'closed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('connected', 'no_answer', 'busy', 'switched_off', 'wrong_number');--> statement-breakpoint
CREATE TYPE "public"."customer_status" AS ENUM('active', 'inactive', 'deactivated');--> statement-breakpoint
CREATE TYPE "public"."dest_kind" AS ENUM('personal', 'group');--> statement-breakpoint
CREATE TYPE "public"."follow_up_channel" AS ENUM('whatsapp', 'call');--> statement-breakpoint
CREATE TYPE "public"."help_type" AS ENUM('sop', 'call_script', 'system_guide', 'policy');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('prepared', 'copied', 'sent_manually', 'queued', 'sent', 'delivered', 'read', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."order_source" AS ENUM('crm', 'external');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('captured', 'confirmed', 'dispatched', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('pending', 'completed', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."reminder_type" AS ENUM('call_back', 'payment_promise', 'order_confirmation', 'send_information', 'check_stock', 'other');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('telecaller', 'manager', 'admin');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('active', 'paused', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."send_mode" AS ENUM('manual', 'automatic');--> statement-breakpoint
CREATE TYPE "public"."setting_type" AS ENUM('integer', 'decimal', 'text', 'boolean', 'structured');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."source_module" AS ENUM('call_queue', 'payment_follow_up', 'inactive_watch', 'ad_hoc');--> statement-breakpoint
CREATE TYPE "public"."template_category" AS ENUM('order_confirmation', 'payment_reminder', 'routine_check_in', 'reactivation', 'other');--> statement-breakpoint
CREATE TYPE "public"."watch_outcome" AS ENUM('contacted', 'reminder_set', 'deactivation_requested', 'not_actually_inactive');--> statement-breakpoint
CREATE TABLE "app_access" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"app" "app_id" NOT NULL,
	"granted_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"value_type" "setting_type" NOT NULL,
	"category" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text
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
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before_state" jsonb,
	"after_state" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"bill_no" text NOT NULL,
	"bill_date" date NOT NULL,
	"due_date" date,
	"amount" bigint NOT NULL,
	"paid_amount" bigint DEFAULT 0 NOT NULL,
	"status" "bill_status" DEFAULT 'unpaid' NOT NULL,
	"disputed" boolean DEFAULT false NOT NULL,
	"external_ref" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_by_id" text
);
--> statement-breakpoint
CREATE TABLE "bug_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"description" text NOT NULL,
	"screen" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"user_id" text NOT NULL,
	"direction" "call_direction" DEFAULT 'outbound' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_seconds" integer,
	"connection_status" "connection_status" NOT NULL,
	"outcome" "call_outcome",
	"notes" text,
	"source_module" "source_module" DEFAULT 'ad_hoc' NOT NULL,
	"order_id" text,
	"reminder_id" text,
	"complaint_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_by_id" text
);
--> statement-breakpoint
CREATE TABLE "complaint_images" (
	"id" text PRIMARY KEY NOT NULL,
	"complaint_id" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "complaint_status_history" (
	"id" text PRIMARY KEY NOT NULL,
	"complaint_id" text NOT NULL,
	"from_status" "complaint_status",
	"to_status" "complaint_status" NOT NULL,
	"changed_by_id" text,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "complaints" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"logged_by_user_id" text NOT NULL,
	"call_id" text,
	"category" "complaint_category" NOT NULL,
	"description" text NOT NULL,
	"severity" "severity" DEFAULT 'medium' NOT NULL,
	"assigned_to" text DEFAULT 'Operations' NOT NULL,
	"status" "complaint_status" DEFAULT 'open' NOT NULL,
	"related_bill_id" text,
	"related_order_id" text,
	"resolution_notes" text,
	"resolved_at" timestamp with time zone,
	"resolved_by_id" text,
	"customer_informed" boolean DEFAULT false NOT NULL,
	"sla_due_at" timestamp with time zone NOT NULL,
	"sla_escalated_at" timestamp with time zone,
	"request_cn" boolean DEFAULT false NOT NULL,
	"bill_id" text,
	"goods_description" text,
	"mobile_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_by_id" text
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"external_code" text,
	"name" text NOT NULL,
	"contact_person" text NOT NULL,
	"phone" text NOT NULL,
	"whatsapp_phone" text,
	"whatsapp_dest" "dest_kind" DEFAULT 'personal' NOT NULL,
	"whatsapp_group_name" text,
	"alt_phone" text,
	"address" text,
	"city" text NOT NULL,
	"region" text,
	"status" "customer_status" DEFAULT 'active' NOT NULL,
	"owner_id" text,
	"deactivated_at" timestamp with time zone,
	"deactivated_by_id" text,
	"deactivation_reason" text,
	"deactivation_requested" boolean DEFAULT false NOT NULL,
	"gstin" text,
	"credit_term_days" integer DEFAULT 30 NOT NULL,
	"route" text,
	"customer_since" date,
	"cycle_days" integer DEFAULT 30 NOT NULL,
	"cycle_is_default" boolean DEFAULT true NOT NULL,
	"last_order_date" date,
	"last_order_value" bigint DEFAULT 0 NOT NULL,
	"last_contact_date" date,
	"last_confirmed_whatsapp_date" date,
	"active_in_order_system" boolean DEFAULT false NOT NULL,
	"outstanding" bigint DEFAULT 0 NOT NULL,
	"avg_order_value" bigint DEFAULT 0 NOT NULL,
	"slow_payer" boolean DEFAULT false NOT NULL,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_by_id" text
);
--> statement-breakpoint
CREATE TABLE "eod_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"body" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"auto_generated" boolean DEFAULT false NOT NULL,
	"finalised_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follow_up_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"stage" integer NOT NULL,
	"channel" "follow_up_channel" NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"user_id" text NOT NULL,
	"outcome" text,
	"promised_amount" bigint,
	"promised_date" date,
	"reminder_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text
);
--> statement-breakpoint
CREATE TABLE "follow_up_states" (
	"customer_id" text PRIMARY KEY NOT NULL,
	"stage" integer NOT NULL,
	"stage_entered_at" timestamp with time zone NOT NULL,
	"oldest_overdue_bill_date" date,
	"days_overdue" integer DEFAULT 0 NOT NULL,
	"total_overdue" bigint DEFAULT 0 NOT NULL,
	"overdue_bill_count" integer DEFAULT 0 NOT NULL,
	"last_channel" "follow_up_channel",
	"last_follow_up_at" timestamp with time zone,
	"next_channel" "follow_up_channel" NOT NULL,
	"held" boolean DEFAULT false NOT NULL,
	"held_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "help_articles" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text NOT NULL,
	"type" "help_type" DEFAULT 'sop' NOT NULL,
	"roles" jsonb NOT NULL,
	"script_body" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_by_id" text
);
--> statement-breakpoint
CREATE TABLE "inactive_watch_items" (
	"customer_id" text PRIMARY KEY NOT NULL,
	"flagged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cycles_elapsed" text NOT NULL,
	"days_since_last_order" integer NOT NULL,
	"value_at_risk" bigint DEFAULT 0 NOT NULL,
	"outcome" "watch_outcome",
	"outcome_at" timestamp with time zone,
	"outcome_by_id" text,
	"outcome_reason" text,
	"dismissed_until" date
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"records_affected" integer DEFAULT 0 NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"detail" text,
	"triggered_by_id" text
);
--> statement-breakpoint
CREATE TABLE "monthly_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"target_amount" bigint NOT NULL,
	"is_default" boolean DEFAULT true NOT NULL,
	"set_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_by_id" text
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
	"user_id" text,
	"source" "order_source" DEFAULT 'crm' NOT NULL,
	"external_ref" text,
	"ordered_at" timestamp with time zone NOT NULL,
	"total_amount" bigint NOT NULL,
	"status" "order_status" DEFAULT 'captured' NOT NULL,
	"call_id" text,
	"line_items" jsonb,
	"expected_dispatch" date,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_by_id" text
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"bill_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"paid_at" date NOT NULL,
	"mode" text DEFAULT 'Bank transfer' NOT NULL,
	"reference" text,
	"external_ref" text,
	"recorded_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_by_id" text
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"assigned_user_id" text NOT NULL,
	"call_id" text,
	"due_date" date NOT NULL,
	"note" text NOT NULL,
	"type" "reminder_type" DEFAULT 'call_back' NOT NULL,
	"status" "reminder_status" DEFAULT 'pending' NOT NULL,
	"system_generated" boolean DEFAULT false NOT NULL,
	"reschedule_count" integer DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_id" text,
	"closure_note" text,
	"dismiss_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_by_id" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"reports_to_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_by_id" text
);
--> statement-breakpoint
CREATE TABLE "wa_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"template_id" text,
	"template_name" text,
	"user_id" text NOT NULL,
	"mode" "send_mode" DEFAULT 'manual' NOT NULL,
	"dest_kind" "dest_kind" DEFAULT 'personal' NOT NULL,
	"resolved_destination" text NOT NULL,
	"body" text NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"status" "message_status" DEFAULT 'prepared' NOT NULL,
	"run_id" text,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"copied_at" timestamp with time zone,
	"confirmed_sent_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failure_reason" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_by_id" text
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
	"mode" "send_mode" DEFAULT 'manual' NOT NULL,
	"filter_key" text NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"status" "run_status" DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by_id" text
);
--> statement-breakpoint
CREATE TABLE "wa_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" "template_category" NOT NULL,
	"escalation_stage" integer,
	"body" text NOT NULL,
	"applies_to" "dest_kind" DEFAULT 'personal' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_by_id" text
);
--> statement-breakpoint
ALTER TABLE "app_access" ADD CONSTRAINT "app_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_access" ADD CONSTRAINT "app_access_granted_by_id_users_id_fk" FOREIGN KEY ("granted_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_images" ADD CONSTRAINT "complaint_images_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "public"."complaints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_status_history" ADD CONSTRAINT "complaint_status_history_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "public"."complaints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_status_history" ADD CONSTRAINT "complaint_status_history_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_logged_by_user_id_users_id_fk" FOREIGN KEY ("logged_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_deactivated_by_id_users_id_fk" FOREIGN KEY ("deactivated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eod_reports" ADD CONSTRAINT "eod_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_attempts" ADD CONSTRAINT "follow_up_attempts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_attempts" ADD CONSTRAINT "follow_up_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_states" ADD CONSTRAINT "follow_up_states_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inactive_watch_items" ADD CONSTRAINT "inactive_watch_items_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inactive_watch_items" ADD CONSTRAINT "inactive_watch_items_outcome_by_id_users_id_fk" FOREIGN KEY ("outcome_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_triggered_by_id_users_id_fk" FOREIGN KEY ("triggered_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_targets" ADD CONSTRAINT "monthly_targets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_targets" ADD CONSTRAINT "monthly_targets_set_by_id_users_id_fk" FOREIGN KEY ("set_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_closed_by_id_users_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_template_id_wa_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."wa_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_run_id_wa_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."wa_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_replies" ADD CONSTRAINT "wa_replies_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_runs" ADD CONSTRAINT "wa_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_runs" ADD CONSTRAINT "wa_runs_template_id_wa_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."wa_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_access_user_app_key" ON "app_access" USING btree ("user_id","app");--> statement-breakpoint
CREATE INDEX "app_access_user_idx" ON "app_access" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_user_day_key" ON "attendance" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "attendance_day_idx" ON "attendance" USING btree ("day");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "bills_no_key" ON "bills" USING btree ("bill_no");--> statement-breakpoint
CREATE INDEX "bills_customer_idx" ON "bills" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "bills_due_idx" ON "bills" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "calls_customer_idx" ON "calls" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "calls_user_started_idx" ON "calls" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "calls_started_idx" ON "calls" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_idempotency_key" ON "calls" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "complaint_history_idx" ON "complaint_status_history" USING btree ("complaint_id");--> statement-breakpoint
CREATE INDEX "complaints_customer_idx" ON "complaints" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "complaints_status_idx" ON "complaints" USING btree ("status");--> statement-breakpoint
CREATE INDEX "complaints_sla_idx" ON "complaints" USING btree ("sla_due_at");--> statement-breakpoint
CREATE INDEX "customers_owner_idx" ON "customers" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "customers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "customers_phone_idx" ON "customers" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "customers_status_idx" ON "customers" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_external_code_key" ON "customers" USING btree ("external_code");--> statement-breakpoint
CREATE UNIQUE INDEX "eod_user_day_key" ON "eod_reports" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "follow_up_attempts_customer_idx" ON "follow_up_attempts" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "follow_up_attempts_idempotency_key" ON "follow_up_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "follow_up_stage_idx" ON "follow_up_states" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "watch_flagged_idx" ON "inactive_watch_items" USING btree ("flagged_at");--> statement-breakpoint
CREATE INDEX "job_runs_job_idx" ON "job_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_targets_key" ON "monthly_targets" USING btree ("customer_id","year","month");--> statement-breakpoint
CREATE INDEX "monthly_targets_period_idx" ON "monthly_targets" USING btree ("year","month");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_ordered_idx" ON "orders" USING btree ("ordered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_external_ref_key" ON "orders" USING btree ("external_ref");--> statement-breakpoint
CREATE INDEX "payments_customer_idx" ON "payments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "payments_paid_idx" ON "payments" USING btree ("paid_at");--> statement-breakpoint
CREATE INDEX "reminders_assigned_due_idx" ON "reminders" USING btree ("assigned_user_id","due_date");--> statement-breakpoint
CREATE INDEX "reminders_customer_idx" ON "reminders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "reminders_status_idx" ON "reminders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_reports_to_idx" ON "users" USING btree ("reports_to_id");--> statement-breakpoint
CREATE INDEX "wa_messages_customer_idx" ON "wa_messages" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "wa_messages_status_idx" ON "wa_messages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "wa_messages_run_idx" ON "wa_messages" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_messages_idempotency_key" ON "wa_messages" USING btree ("idempotency_key");