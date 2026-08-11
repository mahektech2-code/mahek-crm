-- MBOS — the field sales app's data layer.
--
-- One migration, three things: the shared customer master grows the columns a
-- salesman fills in (GPS, beat, credit limit, health score); `timeline_events`
-- lands unprefixed, because it is the stream BOTH apps write to; and the
-- mbos_ tables arrive carrying client-generated ids, two clocks and a device
-- id, per mbos-app/PROTOCOL.md §1–2.
--
-- The six `attachment_parent` values below are ADDED and used by nothing.
-- Postgres refuses to use an enum value in the transaction that adds it and
-- drizzle-kit applies every pending migration in one, so declaring them here
-- is what lets the MBOS routes reference them in the release after this.
CREATE TYPE "public"."customer_potential" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('dealer', 'manufacturer', 'distributor', 'retailer');--> statement-breakpoint
CREATE TYPE "public"."mbos_approval_state" AS ENUM('pending', 'approved', 'rejected', 'partially_approved');--> statement-breakpoint
CREATE TYPE "public"."mbos_approval_type" AS ENUM('order', 'expense_claim', 'leave', 'tour', 'sample', 'attendance_regularisation');--> statement-breakpoint
CREATE TYPE "public"."mbos_attendance_status" AS ENUM('present', 'half_day', 'absent', 'on_leave', 'holiday');--> statement-breakpoint
CREATE TYPE "public"."mbos_document_category" AS ENUM('price_list', 'catalogue', 'agreement', 'kyc', 'policy', 'marketing');--> statement-breakpoint
CREATE TYPE "public"."mbos_expense_category" AS ENUM('travel', 'food', 'lodging', 'other');--> statement-breakpoint
CREATE TYPE "public"."mbos_journey_plan_status" AS ENUM('draft', 'active', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."mbos_journey_stop_status" AS ENUM('planned', 'visited', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."mbos_lead_source" AS ENUM('manual', 'website', 'referral', 'exhibition', 'cold_call', 'whatsapp', 'campaign');--> statement-breakpoint
CREATE TYPE "public"."mbos_lead_stage" AS ENUM('new', 'contacted', 'qualified', 'negotiation', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."mbos_leave_type" AS ENUM('casual', 'sick', 'earned', 'loss_of_pay');--> statement-breakpoint
CREATE TYPE "public"."mbos_sample_outcome" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."mbos_task_priority" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."mbos_task_status" AS ENUM('open', 'in_progress', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."mbos_visit_outcome" AS ENUM('visited', 'order', 'payment', 'complaint', 'sample', 'not_available', 'closed');--> statement-breakpoint
CREATE TYPE "public"."timeline_source_app" AS ENUM('crm', 'mbos');--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE 'mbos_visit';--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE 'mbos_expense';--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE 'mbos_attendance';--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE 'mbos_sample';--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE 'mbos_task';--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE 'mbos_document';--> statement-breakpoint
CREATE TABLE "mbos_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"type" "mbos_approval_type" NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"reason" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approver_user_id" text,
	"state" "mbos_approval_state" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"approved_amount_paise" bigint
);
--> statement-breakpoint
CREATE TABLE "mbos_attendance_days" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"check_in_at" timestamp with time zone,
	"check_in_lat" double precision,
	"check_in_lng" double precision,
	"check_in_accuracy_m" integer,
	"check_in_selfie_id" text,
	"check_in_address" text,
	"check_out_at" timestamp with time zone,
	"check_out_lat" double precision,
	"check_out_lng" double precision,
	"check_out_accuracy_m" integer,
	"check_out_address" text,
	"auto_checked_out" boolean DEFAULT false NOT NULL,
	"worked_seconds" integer,
	"status" "mbos_attendance_status" DEFAULT 'absent' NOT NULL,
	"within_geofence" boolean,
	"geofence_distance_m" integer,
	"regularisation_requested" boolean DEFAULT false NOT NULL,
	"regularisation_reason" text
);
--> statement-breakpoint
CREATE TABLE "mbos_competitor_records" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"customer_id" text NOT NULL,
	"visit_id" text,
	"competitor_name" text NOT NULL,
	"product_name" text,
	"price_paise" bigint,
	"credit_days" integer,
	"delivery_note" text,
	"strengths" text,
	"weaknesses" text,
	"recorded_on" date
);
--> statement-breakpoint
CREATE TABLE "mbos_conflicts" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"record_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"local_version" jsonb,
	"server_version" jsonb,
	"resolution" text,
	"flagged_for_review" boolean DEFAULT false NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mbos_course_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"course_id" text NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"quiz_score_percent" integer,
	"passed" boolean DEFAULT false NOT NULL,
	"certificate_ref" text
);
--> statement-breakpoint
CREATE TABLE "mbos_courses" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"title" text NOT NULL,
	"category" text,
	"duration_minutes" integer,
	"attachment_id" text,
	"pass_mark_percent" integer,
	"mandatory" boolean DEFAULT false NOT NULL,
	"due_date" date,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mbos_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text NOT NULL,
	"user_id" text NOT NULL,
	"model" text,
	"platform" text,
	"app_version" text,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text
);
--> statement-breakpoint
CREATE TABLE "mbos_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"title" text NOT NULL,
	"category" "mbos_document_category" NOT NULL,
	"attachment_id" text,
	"customer_id" text,
	"visible_to_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mbos_expense_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"user_id" text NOT NULL,
	"period_from" date,
	"period_to" date,
	"submitted_at" timestamp with time zone,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "mbos_expenses" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"user_id" text NOT NULL,
	"expense_date" date NOT NULL,
	"category" "mbos_expense_category" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"bill_photo_id" text,
	"remarks" text,
	"claim_id" text,
	"tour_id" text
);
--> statement-breakpoint
CREATE TABLE "mbos_internal_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"customer_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"visible_to_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_id" text
);
--> statement-breakpoint
CREATE TABLE "mbos_journey_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"user_id" text NOT NULL,
	"plan_date" date NOT NULL,
	"beat" text,
	"area" text,
	"status" "mbos_journey_plan_status" DEFAULT 'draft' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"optimised" boolean DEFAULT false NOT NULL,
	"estimated_travel_minutes" integer,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "mbos_journey_stops" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"plan_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"planned_at" timestamp with time zone,
	"actual_visit_at" timestamp with time zone,
	"status" "mbos_journey_stop_status" DEFAULT 'planned' NOT NULL,
	"skip_reason" text
);
--> statement-breakpoint
CREATE TABLE "mbos_leads" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"name" text NOT NULL,
	"company_name" text,
	"mobile" text,
	"city" text,
	"area" text,
	"source" "mbos_lead_source" DEFAULT 'manual' NOT NULL,
	"estimated_potential_paise" bigint,
	"assigned_to_user_id" text,
	"stage" "mbos_lead_stage" DEFAULT 'new' NOT NULL,
	"next_follow_up_date" date,
	"notes" text,
	"gps_lat" double precision,
	"gps_lng" double precision,
	"converted_customer_id" text,
	"converted_at" timestamp with time zone,
	"lost_reason" text,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"last_activity_date" date
);
--> statement-breakpoint
CREATE TABLE "mbos_leave_balances" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"user_id" text NOT NULL,
	"year" integer NOT NULL,
	"leave_type" "mbos_leave_type" NOT NULL,
	"entitled_days" integer DEFAULT 0 NOT NULL,
	"used_days" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mbos_leave_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"user_id" text NOT NULL,
	"leave_type" "mbos_leave_type" NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"half_day" boolean DEFAULT false NOT NULL,
	"days" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text
);
--> statement-breakpoint
CREATE TABLE "mbos_price_list" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"customer_price_tag" text NOT NULL,
	"product_id" text NOT NULL,
	"rate_paise" bigint NOT NULL,
	"valid_from" date,
	"valid_to" date
);
--> statement-breakpoint
CREATE TABLE "mbos_samples" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"customer_id" text NOT NULL,
	"salesman_id" text NOT NULL,
	"product_id" text,
	"quantity_cans" integer,
	"requested_date" date,
	"delivered_at" timestamp with time zone,
	"delivery_photo_id" text,
	"trial_outcome" "mbos_sample_outcome" DEFAULT 'pending' NOT NULL,
	"follow_up_date" date,
	"feedback_notes" text,
	"converted_order_id" text
);
--> statement-breakpoint
CREATE TABLE "mbos_schemes" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"name" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"eligibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"benefit" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"valid_from" date,
	"valid_to" date
);
--> statement-breakpoint
CREATE TABLE "mbos_sync_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"device_id" text,
	"user_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"result_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mbos_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"title" text NOT NULL,
	"description" text,
	"assigned_to_user_id" text NOT NULL,
	"assigned_by_user_id" text,
	"priority" "mbos_task_priority" DEFAULT 'medium' NOT NULL,
	"due_date" date,
	"customer_id" text,
	"status" "mbos_task_status" DEFAULT 'open' NOT NULL,
	"completion_note" text,
	"completion_photo_id" text,
	"completed_at" timestamp with time zone,
	"snoozed_to" date,
	"snooze_reason" text,
	"escalated_at" timestamp with time zone,
	"source_type" text,
	"source_id" text
);
--> statement-breakpoint
CREATE TABLE "mbos_tours" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"user_id" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"cities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"purpose" text,
	"estimated_cost_paise" bigint,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "mbos_visits" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"customer_id" text NOT NULL,
	"salesman_id" text NOT NULL,
	"check_in_lat" double precision,
	"check_in_lng" double precision,
	"check_in_accuracy_m" integer,
	"check_in_at" timestamp with time zone,
	"check_out_lat" double precision,
	"check_out_lng" double precision,
	"check_out_accuracy_m" integer,
	"check_out_at" timestamp with time zone,
	"duration_seconds" integer,
	"shop_photo_id" text,
	"cust_photo_id" text,
	"voice_note_id" text,
	"transcript" text,
	"transcript_is_ai" boolean DEFAULT false NOT NULL,
	"outcome" "mbos_visit_outcome" DEFAULT 'visited' NOT NULL,
	"notes" text,
	"linked_order_id" text,
	"linked_payment_id" text,
	"linked_complaint_id" text,
	"linked_sample_id" text,
	"next_follow_up_date" date,
	"journey_plan_stop_id" text,
	"was_planned" boolean DEFAULT false NOT NULL,
	"deviation_reason" text,
	"location_mismatch" boolean DEFAULT false NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"unverified_reason" text
);
--> statement-breakpoint
CREATE TABLE "timeline_events" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"event_type" text NOT NULL,
	"source_app" timeline_source_app NOT NULL,
	"source_record_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_user_id" text,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "gps_lat" double precision;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "gps_lng" double precision;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "gps_accuracy_m" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "gps_captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "beat" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "area" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "territory_region" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "customer_type" "customer_type";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "potential" "customer_potential";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "credit_limit_paise" bigint;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "credit_blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "credit_block_reason" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "health_score" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "health_components" jsonb;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "health_computed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_visit_date" date;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "visit_frequency_days" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "dealer_code" text;--> statement-breakpoint
ALTER TABLE "mbos_approvals" ADD CONSTRAINT "mbos_approvals_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_approvals" ADD CONSTRAINT "mbos_approvals_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_attendance_days" ADD CONSTRAINT "mbos_attendance_days_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_attendance_days" ADD CONSTRAINT "mbos_attendance_days_check_in_selfie_id_attachments_id_fk" FOREIGN KEY ("check_in_selfie_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_competitor_records" ADD CONSTRAINT "mbos_competitor_records_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_competitor_records" ADD CONSTRAINT "mbos_competitor_records_visit_id_mbos_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."mbos_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_conflicts" ADD CONSTRAINT "mbos_conflicts_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_course_progress" ADD CONSTRAINT "mbos_course_progress_course_id_mbos_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."mbos_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_course_progress" ADD CONSTRAINT "mbos_course_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_courses" ADD CONSTRAINT "mbos_courses_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_devices" ADD CONSTRAINT "mbos_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_documents" ADD CONSTRAINT "mbos_documents_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_documents" ADD CONSTRAINT "mbos_documents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_expense_claims" ADD CONSTRAINT "mbos_expense_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_expenses" ADD CONSTRAINT "mbos_expenses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_expenses" ADD CONSTRAINT "mbos_expenses_bill_photo_id_attachments_id_fk" FOREIGN KEY ("bill_photo_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_expenses" ADD CONSTRAINT "mbos_expenses_claim_id_mbos_expense_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."mbos_expense_claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_internal_notes" ADD CONSTRAINT "mbos_internal_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_internal_notes" ADD CONSTRAINT "mbos_internal_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_journey_plans" ADD CONSTRAINT "mbos_journey_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_journey_stops" ADD CONSTRAINT "mbos_journey_stops_plan_id_mbos_journey_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."mbos_journey_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_journey_stops" ADD CONSTRAINT "mbos_journey_stops_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_leads" ADD CONSTRAINT "mbos_leads_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_leads" ADD CONSTRAINT "mbos_leads_converted_customer_id_customers_id_fk" FOREIGN KEY ("converted_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_leave_balances" ADD CONSTRAINT "mbos_leave_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_leave_requests" ADD CONSTRAINT "mbos_leave_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_price_list" ADD CONSTRAINT "mbos_price_list_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD CONSTRAINT "mbos_samples_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD CONSTRAINT "mbos_samples_salesman_id_users_id_fk" FOREIGN KEY ("salesman_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD CONSTRAINT "mbos_samples_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD CONSTRAINT "mbos_samples_delivery_photo_id_attachments_id_fk" FOREIGN KEY ("delivery_photo_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_samples" ADD CONSTRAINT "mbos_samples_converted_order_id_orders_id_fk" FOREIGN KEY ("converted_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_sync_receipts" ADD CONSTRAINT "mbos_sync_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_tasks" ADD CONSTRAINT "mbos_tasks_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_tasks" ADD CONSTRAINT "mbos_tasks_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_tasks" ADD CONSTRAINT "mbos_tasks_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_tasks" ADD CONSTRAINT "mbos_tasks_completion_photo_id_attachments_id_fk" FOREIGN KEY ("completion_photo_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_tours" ADD CONSTRAINT "mbos_tours_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_visits" ADD CONSTRAINT "mbos_visits_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_visits" ADD CONSTRAINT "mbos_visits_salesman_id_users_id_fk" FOREIGN KEY ("salesman_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_visits" ADD CONSTRAINT "mbos_visits_shop_photo_id_attachments_id_fk" FOREIGN KEY ("shop_photo_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_visits" ADD CONSTRAINT "mbos_visits_cust_photo_id_attachments_id_fk" FOREIGN KEY ("cust_photo_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_visits" ADD CONSTRAINT "mbos_visits_voice_note_id_attachments_id_fk" FOREIGN KEY ("voice_note_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_visits" ADD CONSTRAINT "mbos_visits_linked_order_id_orders_id_fk" FOREIGN KEY ("linked_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_visits" ADD CONSTRAINT "mbos_visits_linked_payment_id_payment_receipts_id_fk" FOREIGN KEY ("linked_payment_id") REFERENCES "public"."payment_receipts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_visits" ADD CONSTRAINT "mbos_visits_linked_complaint_id_complaints_id_fk" FOREIGN KEY ("linked_complaint_id") REFERENCES "public"."complaints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_visits" ADD CONSTRAINT "mbos_visits_linked_sample_id_mbos_samples_id_fk" FOREIGN KEY ("linked_sample_id") REFERENCES "public"."mbos_samples"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mbos_visits" ADD CONSTRAINT "mbos_visits_journey_plan_stop_id_mbos_journey_stops_id_fk" FOREIGN KEY ("journey_plan_stop_id") REFERENCES "public"."mbos_journey_stops"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mbos_approvals_pending_idx" ON "mbos_approvals" USING btree ("state","requested_at");--> statement-breakpoint
CREATE INDEX "mbos_approvals_subject_idx" ON "mbos_approvals" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "mbos_approvals_requester_idx" ON "mbos_approvals" USING btree ("requested_by_user_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "mbos_attendance_days_user_day_key" ON "mbos_attendance_days" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "mbos_attendance_days_day_idx" ON "mbos_attendance_days" USING btree ("day");--> statement-breakpoint
CREATE INDEX "mbos_competitor_records_customer_idx" ON "mbos_competitor_records" USING btree ("customer_id","recorded_on");--> statement-breakpoint
CREATE INDEX "mbos_conflicts_record_idx" ON "mbos_conflicts" USING btree ("entity_type","record_id");--> statement-breakpoint
CREATE INDEX "mbos_conflicts_review_idx" ON "mbos_conflicts" USING btree ("flagged_for_review","server_created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mbos_course_progress_key" ON "mbos_course_progress" USING btree ("course_id","user_id");--> statement-breakpoint
CREATE INDEX "mbos_course_progress_user_idx" ON "mbos_course_progress" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mbos_courses_active_idx" ON "mbos_courses" USING btree ("active","mandatory");--> statement-breakpoint
CREATE UNIQUE INDEX "mbos_devices_device_key" ON "mbos_devices" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "mbos_devices_user_idx" ON "mbos_devices" USING btree ("user_id","active");--> statement-breakpoint
CREATE INDEX "mbos_documents_category_idx" ON "mbos_documents" USING btree ("category","active");--> statement-breakpoint
CREATE INDEX "mbos_documents_customer_idx" ON "mbos_documents" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "mbos_expense_claims_user_idx" ON "mbos_expense_claims" USING btree ("user_id","submitted_at");--> statement-breakpoint
CREATE INDEX "mbos_expenses_user_idx" ON "mbos_expenses" USING btree ("user_id","expense_date");--> statement-breakpoint
CREATE INDEX "mbos_expenses_claim_idx" ON "mbos_expenses" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "mbos_internal_notes_customer_idx" ON "mbos_internal_notes" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mbos_journey_plans_user_day_key" ON "mbos_journey_plans" USING btree ("user_id","plan_date");--> statement-breakpoint
CREATE INDEX "mbos_journey_plans_date_idx" ON "mbos_journey_plans" USING btree ("plan_date");--> statement-breakpoint
CREATE INDEX "mbos_journey_stops_plan_idx" ON "mbos_journey_stops" USING btree ("plan_id","sequence");--> statement-breakpoint
CREATE INDEX "mbos_journey_stops_customer_idx" ON "mbos_journey_stops" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "mbos_leads_assigned_idx" ON "mbos_leads" USING btree ("assigned_to_user_id","stage");--> statement-breakpoint
CREATE INDEX "mbos_leads_mobile_idx" ON "mbos_leads" USING btree ("mobile");--> statement-breakpoint
CREATE INDEX "mbos_leads_stale_idx" ON "mbos_leads" USING btree ("archived","last_activity_date");--> statement-breakpoint
CREATE UNIQUE INDEX "mbos_leave_balances_key" ON "mbos_leave_balances" USING btree ("user_id","year","leave_type");--> statement-breakpoint
CREATE INDEX "mbos_leave_requests_user_idx" ON "mbos_leave_requests" USING btree ("user_id","from_date");--> statement-breakpoint
CREATE INDEX "mbos_leave_requests_window_idx" ON "mbos_leave_requests" USING btree ("from_date","to_date");--> statement-breakpoint
CREATE INDEX "mbos_price_list_lookup_idx" ON "mbos_price_list" USING btree ("customer_price_tag","product_id","valid_from");--> statement-breakpoint
CREATE INDEX "mbos_price_list_product_idx" ON "mbos_price_list" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "mbos_samples_customer_idx" ON "mbos_samples" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "mbos_samples_follow_up_idx" ON "mbos_samples" USING btree ("trial_outcome","follow_up_date");--> statement-breakpoint
CREATE INDEX "mbos_schemes_active_idx" ON "mbos_schemes" USING btree ("active","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "mbos_sync_receipts_key" ON "mbos_sync_receipts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "mbos_sync_receipts_entity_idx" ON "mbos_sync_receipts" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "mbos_tasks_assignee_idx" ON "mbos_tasks" USING btree ("assigned_to_user_id","status","due_date");--> statement-breakpoint
CREATE INDEX "mbos_tasks_customer_idx" ON "mbos_tasks" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "mbos_tasks_overdue_idx" ON "mbos_tasks" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "mbos_tours_user_idx" ON "mbos_tours" USING btree ("user_id","start_date");--> statement-breakpoint
CREATE INDEX "mbos_visits_customer_idx" ON "mbos_visits" USING btree ("customer_id","check_in_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mbos_visits_salesman_idx" ON "mbos_visits" USING btree ("salesman_id","check_in_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mbos_visits_unverified_idx" ON "mbos_visits" USING btree ("verified","check_in_at");--> statement-breakpoint
CREATE INDEX "timeline_events_customer_idx" ON "timeline_events" USING btree ("customer_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "timeline_events_source_idx" ON "timeline_events" USING btree ("event_type","source_record_id");--> statement-breakpoint
CREATE INDEX "customers_beat_idx" ON "customers" USING btree ("beat");--> statement-breakpoint
CREATE INDEX "customers_dealer_code_idx" ON "customers" USING btree ("dealer_code");