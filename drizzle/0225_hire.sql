-- Hire: AI hiring and onboarding, its own MahekOne app.
--
-- The app id is added here and USED nowhere in this file: a value added to an
-- enum cannot be used in the transaction that adds it, and drizzle-kit runs
-- every pending migration in one. Granting Hire is `npm run app:grant -- hire`
-- or the Access screen, after this has committed.
--
-- Scores, decisions, briefing responses, answers and the audit trail are
-- append-only by design: a correction is a new row and the old one carries
-- superseded_by_id. Identity numbers live in hire_vault, encrypted; the
-- candidate row never holds one.
alter type "public"."app_id" add value if not exists 'hire';
--> statement-breakpoint
create sequence if not exists "hire_candidate_code_seq" start 1001;
--> statement-breakpoint
create table "hire_blueprints" (
  "id" text primary key,
  "key" text not null,
  "version" integer not null,
  "status" text not null default 'draft',
  "title" text not null,
  "family" text not null,
  "department" text not null,
  "level" text not null default 'Executive',
  "employment_type" text not null default 'Full time',
  "locations" jsonb not null default '[]'::jsonb,
  "headcount" integer not null default 1,
  "description_source" text,
  "ai_generated" boolean not null default false,
  "generation_prompt_version" text,
  "parent_id" text,
  "definition" jsonb not null,
  "critic" jsonb,
  "retention_months" integer not null default 24,
  "published_at" timestamp with time zone,
  "published_by_id" text references "users"("id"),
  "retired_at" timestamp with time zone,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "created_by_id" text,
  "updated_by_id" text,
  constraint "hire_blueprints_status" check ("status" in ('draft','published','retired'))
);
--> statement-breakpoint
create unique index "hire_blueprints_key_version" on "hire_blueprints" ("key","version");
--> statement-breakpoint
create table "hire_user_roles" (
  "user_id" text primary key references "users"("id") on delete cascade,
  "role" text not null,
  "granted_by_id" text references "users"("id"),
  "granted_at" timestamp with time zone not null default now()
);
--> statement-breakpoint
create table "hire_candidates" (
  "id" text primary key,
  "code" text not null,
  "primary_phone" text not null,
  "alternate_phone" text,
  "email" text,
  "full_name" text not null,
  "preferred_name" text,
  "name_variants" jsonb not null default '[]'::jsonb,
  "gender" text,
  "age_band" text,
  "location" text,
  "preferred_language" text not null default 'English',
  "source" text,
  "source_detail" text,
  "referred_by" text,
  "consent_at" timestamp with time zone,
  "ai_disclosed_at" timestamp with time zone,
  "do_not_contact" boolean not null default false,
  "dnc_reason" text,
  "talent_pool_status" text not null default 'active',
  "pre_migration" boolean not null default false,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "created_by_id" text,
  "updated_by_id" text,
  constraint "hire_candidates_pool" check ("talent_pool_status" in ('active','silver_medallist','archived','withdrawn'))
);
--> statement-breakpoint
create unique index "hire_candidates_code" on "hire_candidates" ("code");
--> statement-breakpoint
create unique index "hire_candidates_phone" on "hire_candidates" ("primary_phone");
--> statement-breakpoint
create table "hire_applications" (
  "id" text primary key,
  "candidate_id" text not null references "hire_candidates"("id"),
  "blueprint_id" text not null references "hire_blueprints"("id"),
  "applied_at" timestamp with time zone not null default now(),
  "location" text,
  "stage_key" text not null,
  "stage_entered_at" timestamp with time zone not null default now(),
  "status" text not null default 'in_progress',
  "hold_reason" text,
  "recruiter_id" text references "users"("id"),
  "interviewer_id" text references "users"("id"),
  "hiring_manager_id" text references "users"("id"),
  "ai_recommendation" jsonb,
  "rejection_reason_code" text,
  "rejection_stage_key" text,
  "decision_reason" text,
  "reapplication_of_id" text,
  "entered_via" text not null default 'hr',
  "duplicate" jsonb,
  "override" jsonb,
  "hired_at" timestamp with time zone,
  "employee_user_id" text references "users"("id"),
  "closed_at" timestamp with time zone,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "created_by_id" text,
  "updated_by_id" text,
  constraint "hire_applications_status" check ("status" in ('in_progress','on_hold','rejected','withdrawn','offer_declined','hired','archived'))
);
--> statement-breakpoint
create index "hire_applications_candidate" on "hire_applications" ("candidate_id");
--> statement-breakpoint
create index "hire_applications_blueprint" on "hire_applications" ("blueprint_id");
--> statement-breakpoint
create index "hire_applications_status" on "hire_applications" ("status");
--> statement-breakpoint
create table "hire_stage_executions" (
  "id" text primary key,
  "application_id" text not null references "hire_applications"("id"),
  "stage_key" text not null,
  "status" text not null default 'not_started',
  "modality" text,
  "scheduled_at" timestamp with time zone,
  "scheduled_minutes" integer,
  "place" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "conducted_by_id" text references "users"("id"),
  "earned" double precision,
  "max_points" integer,
  "normalised" double precision,
  "grace" integer not null default 0,
  "grace_reason" text,
  "final_score" double precision,
  "outcome" text not null default 'pending',
  "ai_recommendation" text,
  "ai_confidence" double precision,
  "ai_reasoning" text,
  "entry_was_gated" boolean not null default true,
  "gate_override_by_id" text references "users"("id"),
  "gate_override_reason" text,
  "ai_review_pending" boolean not null default false,
  "superseded_by_id" text,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "created_by_id" text,
  "updated_by_id" text,
  constraint "hire_exec_status" check ("status" in ('not_started','scheduled','in_progress','completed','skipped','failed')),
  constraint "hire_exec_outcome" check ("outcome" in ('pass','fail','pending','not_applicable'))
);
--> statement-breakpoint
create index "hire_exec_app" on "hire_stage_executions" ("application_id","stage_key");
--> statement-breakpoint
create index "hire_exec_sched" on "hire_stage_executions" ("scheduled_at");
--> statement-breakpoint
create table "hire_answers" (
  "id" text primary key,
  "execution_id" text not null references "hire_stage_executions"("id"),
  "question_key" text not null,
  "response_text" text,
  "selected" jsonb,
  "calc_inputs" jsonb,
  "score" double precision,
  "max_points" integer not null,
  "scored_by" text,
  "ai_score" double precision,
  "ai_reasoning" text,
  "ai_confidence" double precision,
  "ai_flags" jsonb not null default '[]'::jsonb,
  "evidence" jsonb not null default '[]'::jsonb,
  "probe_suggestion" text,
  "ai_task_id" text,
  "human_action" text,
  "override_reason" text,
  "confirmed_by_id" text references "users"("id"),
  "confirmed_at" timestamp with time zone,
  "notes" text,
  "superseded_by_id" text,
  "created_at" timestamp with time zone not null default now(),
  "created_by_id" text
);
--> statement-breakpoint
create index "hire_answers_exec" on "hire_answers" ("execution_id","question_key");
--> statement-breakpoint
create table "hire_briefing_responses" (
  "id" text primary key,
  "execution_id" text not null references "hire_stage_executions"("id"),
  "point_key" text not null,
  "response" text not null,
  "comment" text,
  "recorded_by_id" text references "users"("id"),
  "recorded_at" timestamp with time zone not null default now(),
  "superseded_by_id" text
);
--> statement-breakpoint
create index "hire_briefing_exec" on "hire_briefing_responses" ("execution_id");
--> statement-breakpoint
create table "hire_decisions" (
  "id" text primary key,
  "application_id" text not null references "hire_applications"("id"),
  "execution_id" text,
  "decision_point" text not null,
  "decided_by_id" text not null references "users"("id"),
  "decided_by_role" text not null,
  "decided_at" timestamp with time zone not null default now(),
  "decision" text not null,
  "reasoning" text not null,
  "reason_code" text,
  "ai_recommendation" jsonb,
  "agreed_with_ai" boolean,
  "evidence_reviewed" jsonb not null default '[]'::jsonb,
  "superseded_by_id" text,
  constraint "hire_decisions_decision" check ("decision" in ('advance','reject','hold','hire','revise_offer','resume','withdraw')),
  constraint "hire_decisions_reasoning" check (length(trim("reasoning")) >= 20)
);
--> statement-breakpoint
create index "hire_decisions_app" on "hire_decisions" ("application_id");
--> statement-breakpoint
create table "hire_rejection_proposals" (
  "id" text primary key,
  "application_id" text not null references "hire_applications"("id"),
  "stage_key" text not null,
  "score" double precision,
  "reason_code" text not null,
  "note" text,
  "proposed_by_id" text references "users"("id"),
  "proposed_at" timestamp with time zone not null default now(),
  "window_ends_at" timestamp with time zone not null,
  "status" text not null default 'open',
  "resolved_by_id" text references "users"("id"),
  "resolved_at" timestamp with time zone,
  "resolution" text,
  constraint "hire_rejections_status" check ("status" in ('open','confirmed','dismissed'))
);
--> statement-breakpoint
create index "hire_rejections_open" on "hire_rejection_proposals" ("status");
--> statement-breakpoint
create table "hire_sessions" (
  "id" text primary key,
  "execution_id" text not null references "hire_stage_executions"("id"),
  "modality" text not null,
  "status" text not null default 'live',
  "started_at" timestamp with time zone not null default now(),
  "ended_at" timestamp with time zone,
  "recording_consent" boolean not null default false,
  "consent_at" timestamp with time zone,
  "ai_disclosed" boolean not null default false,
  "language" text,
  "languages" jsonb not null default '[]'::jsonb,
  "segments" jsonb not null default '[]'::jsonb,
  "copilot" jsonb not null default '[]'::jsonb,
  "audio_file_id" text,
  "candidate_talk_ratio" double precision,
  "escalated" text,
  "interviewer_ids" jsonb not null default '[]'::jsonb,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "created_by_id" text,
  "updated_by_id" text,
  constraint "hire_sessions_status" check ("status" in ('live','ended','abandoned'))
);
--> statement-breakpoint
create index "hire_sessions_exec" on "hire_sessions" ("execution_id");
--> statement-breakpoint
create table "hire_files" (
  "id" text primary key,
  "candidate_id" text not null references "hire_candidates"("id"),
  "application_id" text,
  "purpose" text not null,
  "filename" text not null,
  "content_type" text not null,
  "size_bytes" integer not null,
  "stored_ref" text not null,
  "uploaded_by_id" text,
  "uploaded_at" timestamp with time zone not null default now(),
  "removed_at" timestamp with time zone
);
--> statement-breakpoint
create index "hire_files_candidate" on "hire_files" ("candidate_id");
--> statement-breakpoint
create table "hire_vault" (
  "id" text primary key,
  "candidate_id" text not null references "hire_candidates"("id"),
  "kind" text not null,
  "ciphertext" text not null,
  "last4" text not null,
  "created_by_id" text,
  "created_at" timestamp with time zone not null default now(),
  "purged_at" timestamp with time zone
);
--> statement-breakpoint
create table "hire_documents" (
  "id" text primary key,
  "application_id" text not null references "hire_applications"("id"),
  "requirement_key" text not null,
  "file_id" text,
  "vault_id" text,
  "extraction" jsonb,
  "extraction_confidence" double precision,
  "verification_status" text not null default 'pending',
  "verification_notes" text,
  "verified_by_id" text references "users"("id"),
  "verified_at" timestamp with time zone,
  "superseded_by_id" text,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "created_by_id" text,
  "updated_by_id" text,
  constraint "hire_documents_status" check ("verification_status" in ('pending','verified','failed','manual_review','waived'))
);
--> statement-breakpoint
create index "hire_documents_app" on "hire_documents" ("application_id");
--> statement-breakpoint
create table "hire_profiles" (
  "application_id" text primary key references "hire_applications"("id"),
  "data" jsonb not null,
  "corrections" jsonb not null default '[]'::jsonb,
  "source_file_id" text,
  "extraction_confidence" double precision,
  "extracted_at" timestamp with time zone,
  "ai_task_id" text,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
create table "hire_offers" (
  "id" text primary key,
  "application_id" text not null references "hire_applications"("id"),
  "status" text not null default 'draft',
  "grade" text not null,
  "grade_label" text not null,
  "basic_paise" bigint not null,
  "currency" text not null default 'INR',
  "incentive" text,
  "ctc_paise" bigint,
  "growth" jsonb not null default '[]'::jsonb,
  "letter" text,
  "growth_confirmation" text,
  "letter_confirmation" text,
  "background_check" text not null default 'needed',
  "courier_status" text not null default 'not_sent',
  "joining_date" date,
  "expiry_date" date,
  "issued_at" timestamp with time zone,
  "issued_by_id" text references "users"("id"),
  "responded_at" timestamp with time zone,
  "response" text,
  "negotiated_from_id" text,
  "superseded_by_id" text,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "created_by_id" text,
  "updated_by_id" text,
  constraint "hire_offers_status" check ("status" in ('draft','issued','accepted','declined','withdrawn'))
);
--> statement-breakpoint
create index "hire_offers_app" on "hire_offers" ("application_id");
--> statement-breakpoint
create table "hire_onboarding_items" (
  "id" text primary key,
  "application_id" text not null references "hire_applications"("id"),
  "kind" text not null,
  "group_key" text not null,
  "item_key" text not null,
  "done" boolean not null default false,
  "serial" text,
  "done_by_id" text references "users"("id"),
  "done_at" timestamp with time zone,
  constraint "hire_onboarding_kind" check ("kind" in ('asset','topic','setup'))
);
--> statement-breakpoint
create unique index "hire_onboarding_item" on "hire_onboarding_items" ("application_id","kind","group_key","item_key");
--> statement-breakpoint
create table "hire_messages" (
  "id" text primary key,
  "candidate_id" text not null references "hire_candidates"("id"),
  "application_id" text,
  "direction" text not null,
  "channel" text not null,
  "language" text not null default 'English',
  "subject" text,
  "body" text not null,
  "ai_drafted" boolean not null default false,
  "ai_task_id" text,
  "status" text not null default 'sent',
  "sent_by_id" text references "users"("id"),
  "at" timestamp with time zone not null default now()
);
--> statement-breakpoint
create index "hire_messages_candidate" on "hire_messages" ("candidate_id","at");
--> statement-breakpoint
create table "hire_ai_tasks" (
  "id" text primary key,
  "task_type" text not null,
  "prompt_version" text not null,
  "tier" text not null,
  "model_id" text,
  "provider" text not null default 'openai',
  "input_hash" text,
  "input_tokens" integer,
  "output" jsonb,
  "output_tokens" integer,
  "latency_ms" integer,
  "cost_paise" integer,
  "status" text not null,
  "error" text,
  "retry_count" integer not null default 0,
  "fallback_used" text,
  "triggered_by_id" text,
  "entity_type" text,
  "entity_id" text,
  "application_id" text,
  "blueprint_id" text,
  "redaction_applied" boolean not null default false,
  "redacted_fields" jsonb not null default '[]'::jsonb,
  "created_at" timestamp with time zone not null default now()
);
--> statement-breakpoint
create index "hire_ai_tasks_type_at" on "hire_ai_tasks" ("task_type","created_at");
--> statement-breakpoint
create index "hire_ai_tasks_app" on "hire_ai_tasks" ("application_id");
--> statement-breakpoint
create index "hire_ai_tasks_hash" on "hire_ai_tasks" ("task_type","input_hash");
--> statement-breakpoint
create table "hire_ai_outputs" (
  "id" text primary key,
  "kind" text not null,
  "application_id" text,
  "blueprint_id" text,
  "content" jsonb not null,
  "ai_task_id" text,
  "created_at" timestamp with time zone not null default now(),
  "created_by_id" text
);
--> statement-breakpoint
create index "hire_ai_outputs_app_kind" on "hire_ai_outputs" ("application_id","kind","created_at");
--> statement-breakpoint
create table "hire_audit" (
  "id" text primary key,
  "application_id" text,
  "candidate_id" text,
  "entity_type" text not null,
  "entity_id" text,
  "event_type" text not null,
  "summary" text not null,
  "actor_id" text,
  "actor_name" text not null,
  "actor_role" text,
  "at" timestamp with time zone not null default now(),
  "before" jsonb,
  "after" jsonb,
  "is_pii_access" boolean not null default false,
  "pii_fields" jsonb not null default '[]'::jsonb,
  "ai_task_id" text
);
--> statement-breakpoint
create index "hire_audit_candidate" on "hire_audit" ("candidate_id","at");
--> statement-breakpoint
create index "hire_audit_at" on "hire_audit" ("at");
--> statement-breakpoint
create index "hire_audit_actor" on "hire_audit" ("actor_id","at");
--> statement-breakpoint
create table "hire_outcomes" (
  "application_id" text primary key references "hire_applications"("id"),
  "left_at" date,
  "first_target_at" date,
  "performance_score" double precision,
  "manager_satisfaction" integer,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
-- The audit trail cannot be edited or deleted, whatever the application does.
create or replace function hire_audit_is_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'hire_audit is append-only';
end;
$$;
--> statement-breakpoint
create trigger "hire_audit_no_update" before update or delete on "hire_audit" for each row execute function hire_audit_is_append_only();
