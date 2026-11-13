-- Locker: the company's licences, policies, contracts, subscriptions and
-- company records, each with an end date and an owner, and the vault of
-- passwords and keys. See the LOCKER section of src/db/schema.ts.
--
-- The app_id value is only declared here, never used: drizzle-kit applies
-- every pending migration in one transaction, and Postgres refuses to use a
-- value in the transaction that added it. The Locker is granted on the Access
-- screen or with: npm run app:grant -- locker <email>
--
-- Seeds the asset-type catalogue (lib/locker/catalogue.ts) and the default
-- reminder schedule per importance. No assets, people or secrets.
ALTER TYPE "public"."app_id" ADD VALUE IF NOT EXISTS 'locker';--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE IF NOT EXISTS 'locker_asset';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"gstin" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_sites" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'office' NOT NULL,
	"state" text DEFAULT '' NOT NULL,
	"hazardous" boolean DEFAULT false NOT NULL,
	"entity_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locker_sites_kind" CHECK ("locker_sites"."kind" in ('office','factory','godown','depot'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_asset_types" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"model" text NOT NULL,
	"validity_months" integer DEFAULT 0 NOT NULL,
	"lead_days" integer DEFAULT 0 NOT NULL,
	"grace_days" integer DEFAULT 0 NOT NULL,
	"criticality" integer DEFAULT 2 NOT NULL,
	"authority" text DEFAULT '' NOT NULL,
	"typical_cost_paise" bigint DEFAULT 0 NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"consequence" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locker_asset_types_model" CHECK ("locker_asset_types"."model" in ('document','subscription','perpetual','term_contract')),
	CONSTRAINT "locker_asset_types_crit" CHECK ("locker_asset_types"."criticality" between 1 and 4)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_payment_methods" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"kind" text DEFAULT 'Credit card' NOT NULL,
	"last4" text DEFAULT '' NOT NULL,
	"expires_on" date,
	"holder" text DEFAULT '' NOT NULL,
	"bank" text DEFAULT '' NOT NULL,
	"personal" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"type_code" text NOT NULL,
	"category" text NOT NULL,
	"criticality" integer NOT NULL,
	"entity_id" text,
	"site_id" text,
	"end_date" date,
	"issued_on" date,
	"stage" text,
	"owner_id" text,
	"backup_id" text,
	"approver_id" text,
	"executor_id" text,
	"department" text DEFAULT '' NOT NULL,
	"external_contact" text,
	"doc_no" text DEFAULT '' NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"amount_paise" bigint DEFAULT 0 NOT NULL,
	"billing_cycle" text DEFAULT '' NOT NULL,
	"payment_method_id" text,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"seats" integer DEFAULT 0 NOT NULL,
	"notice_days" integer DEFAULT 0 NOT NULL,
	"conditions" text,
	"physical_location" text,
	"custodian_id" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"replaces_id" text,
	"archived_at" timestamp with time zone,
	"archived_reason" text,
	"last_checked_at" timestamp with time zone,
	"last_checked_by_id" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locker_assets_code_unique" UNIQUE("code"),
	CONSTRAINT "locker_assets_crit" CHECK ("locker_assets"."criticality" between 1 and 4),
	CONSTRAINT "locker_assets_stage" CHECK ("locker_assets"."stage" is null or "locker_assets"."stage" in ('renewal_in_progress','renewal_filed','awaiting_document','superseded','cancelled','lost','suspended','disputed','draft'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_renewals" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"step" integer DEFAULT 1 NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assigned_to_id" text,
	"applied_on" date,
	"ack_no" text,
	"cost_paise" bigint DEFAULT 0 NOT NULL,
	"new_end_date" date,
	"new_doc_no" text,
	"notes" text,
	"started_by_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by_id" text
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_reminder_schedules" (
	"criticality" integer PRIMARY KEY NOT NULL,
	"offsets" jsonb NOT NULL,
	"updated_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_reminders_sent" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"end_date" date,
	"offset" integer NOT NULL,
	"sent_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text DEFAULT 'organisational' NOT NULL,
	"controlled" boolean DEFAULT true NOT NULL,
	"mfa" boolean DEFAULT false NOT NULL,
	"recovery" boolean DEFAULT false NOT NULL,
	"controlled_by_name" text,
	"owner_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"tier" text DEFAULT 'standard' NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"username" text DEFAULT '' NOT NULL,
	"env" text DEFAULT 'Production' NOT NULL,
	"auth" text DEFAULT 'direct' NOT NULL,
	"via_identity_id" text,
	"sole" boolean DEFAULT false NOT NULL,
	"identity_id" text,
	"asset_id" text,
	"owner_id" text,
	"backup_owner_id" text,
	"mfa" boolean DEFAULT false NOT NULL,
	"mfa_method" text DEFAULT 'none' NOT NULL,
	"recovery_email" text DEFAULT '' NOT NULL,
	"access_level" text DEFAULT '' NOT NULL,
	"revealers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_verified_at" timestamp with time zone,
	"rotate_every_days" integer,
	"last_rotated_at" timestamp with time zone,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locker_credentials_tier" CHECK ("locker_credentials"."tier" in ('standard','sensitive','restricted'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"credential_id" text NOT NULL,
	"field" text NOT NULL,
	"ciphertext" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"kek_version" integer DEFAULT 1 NOT NULL,
	"hint" text DEFAULT '' NOT NULL,
	"fingerprint" text DEFAULT '' NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_links" (
	"id" text PRIMARY KEY NOT NULL,
	"credential_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"kind" text NOT NULL,
	"sole" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_reveals" (
	"id" text PRIMARY KEY NOT NULL,
	"credential_id" text NOT NULL,
	"secret_id" text,
	"field" text NOT NULL,
	"previous" boolean DEFAULT false NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"state" text NOT NULL,
	"decided_by_id" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"revealed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"breakglass_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_breakglass" (
	"id" text PRIMARY KEY NOT NULL,
	"started_by_id" text NOT NULL,
	"reason" text NOT NULL,
	"scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"minutes" integer DEFAULT 60 NOT NULL,
	"state" text DEFAULT 'awaiting' NOT NULL,
	"approved_by_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active_from" timestamp with time zone,
	"active_until" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"ended_by_id" text,
	"review_note" text
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_review_items" (
	"id" text PRIMARY KEY NOT NULL,
	"period" text NOT NULL,
	"user_id" text NOT NULL,
	"module_key" text NOT NULL,
	"decision" text,
	"decided_by_id" text,
	"decided_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_offboarding" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"started_by_id" text NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_settings" (
	"id" text PRIMARY KEY DEFAULT 'locker' NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locker_audit" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "locker_audit_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"actor_name" text DEFAULT '' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text DEFAULT '' NOT NULL,
	"entity_id" text DEFAULT '' NOT NULL,
	"entity_title" text DEFAULT '' NOT NULL,
	"summary" text NOT NULL,
	"reason" text,
	"approved_by_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"security" boolean DEFAULT false NOT NULL,
	"ip" text,
	"user_agent" text,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_assets" ADD CONSTRAINT "locker_assets_type_code_locker_asset_types_code_fk" FOREIGN KEY ("type_code") REFERENCES "public"."locker_asset_types"("code") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_assets" ADD CONSTRAINT "locker_assets_entity_id_locker_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."locker_entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_assets" ADD CONSTRAINT "locker_assets_site_id_locker_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."locker_sites"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_assets" ADD CONSTRAINT "locker_assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_assets" ADD CONSTRAINT "locker_assets_backup_id_users_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_assets" ADD CONSTRAINT "locker_assets_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_assets" ADD CONSTRAINT "locker_assets_executor_id_users_id_fk" FOREIGN KEY ("executor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_assets" ADD CONSTRAINT "locker_assets_payment_method_id_locker_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."locker_payment_methods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_assets" ADD CONSTRAINT "locker_assets_custodian_id_users_id_fk" FOREIGN KEY ("custodian_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_assets" ADD CONSTRAINT "locker_assets_last_checked_by_id_users_id_fk" FOREIGN KEY ("last_checked_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_assets" ADD CONSTRAINT "locker_assets_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_audit" ADD CONSTRAINT "locker_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_audit" ADD CONSTRAINT "locker_audit_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_breakglass" ADD CONSTRAINT "locker_breakglass_started_by_id_users_id_fk" FOREIGN KEY ("started_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_breakglass" ADD CONSTRAINT "locker_breakglass_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_breakglass" ADD CONSTRAINT "locker_breakglass_ended_by_id_users_id_fk" FOREIGN KEY ("ended_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_credentials" ADD CONSTRAINT "locker_credentials_via_identity_id_locker_identities_id_fk" FOREIGN KEY ("via_identity_id") REFERENCES "public"."locker_identities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_credentials" ADD CONSTRAINT "locker_credentials_identity_id_locker_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."locker_identities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_credentials" ADD CONSTRAINT "locker_credentials_asset_id_locker_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."locker_assets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_credentials" ADD CONSTRAINT "locker_credentials_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_credentials" ADD CONSTRAINT "locker_credentials_backup_owner_id_users_id_fk" FOREIGN KEY ("backup_owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_credentials" ADD CONSTRAINT "locker_credentials_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_identities" ADD CONSTRAINT "locker_identities_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_links" ADD CONSTRAINT "locker_links_credential_id_locker_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."locker_credentials"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_links" ADD CONSTRAINT "locker_links_identity_id_locker_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."locker_identities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_offboarding" ADD CONSTRAINT "locker_offboarding_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_offboarding" ADD CONSTRAINT "locker_offboarding_started_by_id_users_id_fk" FOREIGN KEY ("started_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_reminder_schedules" ADD CONSTRAINT "locker_reminder_schedules_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_reminders_sent" ADD CONSTRAINT "locker_reminders_sent_asset_id_locker_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."locker_assets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_renewals" ADD CONSTRAINT "locker_renewals_asset_id_locker_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."locker_assets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_renewals" ADD CONSTRAINT "locker_renewals_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_renewals" ADD CONSTRAINT "locker_renewals_started_by_id_users_id_fk" FOREIGN KEY ("started_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_renewals" ADD CONSTRAINT "locker_renewals_completed_by_id_users_id_fk" FOREIGN KEY ("completed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_reveals" ADD CONSTRAINT "locker_reveals_credential_id_locker_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."locker_credentials"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_reveals" ADD CONSTRAINT "locker_reveals_secret_id_locker_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."locker_secrets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_reveals" ADD CONSTRAINT "locker_reveals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_reveals" ADD CONSTRAINT "locker_reveals_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_review_items" ADD CONSTRAINT "locker_review_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_review_items" ADD CONSTRAINT "locker_review_items_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_secrets" ADD CONSTRAINT "locker_secrets_credential_id_locker_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."locker_credentials"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_secrets" ADD CONSTRAINT "locker_secrets_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_settings" ADD CONSTRAINT "locker_settings_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locker_sites" ADD CONSTRAINT "locker_sites_entity_id_locker_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."locker_entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locker_assets_end_idx" ON "locker_assets" USING btree ("end_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locker_assets_owner_idx" ON "locker_assets" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locker_assets_cat_idx" ON "locker_assets" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locker_audit_entity_idx" ON "locker_audit" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locker_audit_actor_idx" ON "locker_audit" USING btree ("actor_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locker_credentials_via_idx" ON "locker_credentials" USING btree ("via_identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "locker_identities_email" ON "locker_identities" USING btree ("email","provider");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "locker_links_once" ON "locker_links" USING btree ("credential_id","identity_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "locker_reminders_sent_once" ON "locker_reminders_sent" USING btree ("asset_id","end_date","offset");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locker_renewals_asset_idx" ON "locker_renewals" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "locker_renewals_one_open" ON "locker_renewals" USING btree ("asset_id") WHERE "locker_renewals"."completed_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locker_reveals_cred_idx" ON "locker_reveals" USING btree ("credential_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locker_reveals_state_idx" ON "locker_reveals" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "locker_review_items_once" ON "locker_review_items" USING btree ("period","user_id","module_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locker_secrets_cred_idx" ON "locker_secrets" USING btree ("credential_id","field");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "locker_secrets_one_current" ON "locker_secrets" USING btree ("credential_id","field") WHERE "locker_secrets"."retired_at" is null;--> statement-breakpoint
-- The audit is append-only at every privilege the app connects with (spec §9).
CREATE OR REPLACE FUNCTION locker_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'locker_audit is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS locker_audit_no_change ON "locker_audit";--> statement-breakpoint
CREATE TRIGGER locker_audit_no_change BEFORE UPDATE OR DELETE ON "locker_audit" FOR EACH ROW EXECUTE FUNCTION locker_audit_append_only();--> statement-breakpoint
INSERT INTO "locker_reminder_schedules" ("criticality","offsets") VALUES
(4,'[-180,-120,-90,-60,-45,-30,-21,-14,-7,-3,-1,0,1]'::jsonb),
(3,'[-90,-60,-30,-14,-7,-1,0,1]'::jsonb),
(2,'[-45,-30,-14,-7,0,3]'::jsonb),
(1,'[-30,-7,0]'::jsonb)
ON CONFLICT ("criticality") DO NOTHING;--> statement-breakpoint
INSERT INTO "locker_asset_types" ("code","name","category","model","validity_months","lead_days","grace_days","criticality","authority","typical_cost_paise","steps","consequence","fields","system") VALUES
('gst','GST registration','statutory','perpetual',0,0,0,4,'GST Department',0,'[]'::jsonb,'Without an active registration invoices cannot be raised and input credit is lost.','[{"key": "gstin", "label": "GSTIN"}, {"key": "state", "label": "State"}, {"key": "registration_type", "label": "Registration type"}, {"key": "filing_frequency", "label": "Filing frequency"}]'::jsonb,true),
('shops','Shops & Establishment licence','statutory','document',60,60,0,3,'Municipal Corporation',450000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('trade','Trade licence','statutory','document',12,45,15,3,'Municipal Corporation',800000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('factory','Factory licence','statutory','document',12,90,0,4,'Directorate of Industrial Safety & Health',3200000,'[]'::jsonb,'Running the plant without a factory licence exposes the occupier to prosecution and stops production.','[]'::jsonb,true),
('ptax','Professional tax registration','statutory','document',12,30,30,2,'State Sales Tax Department',250000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('lmet','Legal Metrology registration','statutory','document',12,45,0,3,'Legal Metrology Department',600000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('iec','Import Export Code','statutory','perpetual',0,0,0,2,'DGFT',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('peso','PESO petroleum storage licence','hazardous','document',36,120,0,4,'PESO, Nagpur Circle',5800000,'["Download Form XIV renewal from the PESO online portal", "Attach the current licence, site plan and earthing test report (within 12 months)", "Pay the fee online and save the challan", "Submit at least 120 days before end date \u2014 late applying risks a gap in validity", "Respond to any query from the Nagpur circle within 15 days", "Receive the renewed licence; upload it and check the dates and capacity"]'::jsonb,'Solvent storage must stop. Without a valid PESO licence the sites cannot hold petroleum class A/B products — operations halt and stock must be moved.','[{"key": "licence_number", "label": "Licence number"}, {"key": "capacity_in_kl", "label": "Capacity in KL"}, {"key": "products_authorised", "label": "Products authorised"}, {"key": "premises_approved", "label": "Premises approved"}]'::jsonb,true),
('pcb','Pollution Board consent to operate','hazardous','document',60,120,0,4,'State Pollution Control Board',14500000,'["Log in to the MPCB XGN portal and open the consent renewal", "Upload water and air analysis reports from a recognised lab (last 3 months)", "Upload the hazardous waste returns (Form 4) for the year", "Pay the consent fee based on capital investment", "File at least 120 days before end date; applying on time is what keeps you safe in law", "Track site inspection and upload the consent order on receipt"]'::jsonb,'Operating without consent is an offence under the Water and Air Acts. The board can order closure and disconnect power.','[{"key": "consent_number", "label": "Consent number"}, {"key": "category", "label": "Category"}, {"key": "capacity_authorised", "label": "Capacity authorised"}, {"key": "conditions", "label": "Conditions"}]'::jsonb,true),
('fire','Fire NOC','hazardous','document',12,60,15,4,'Fire & Emergency Services',1850000,'["Book the fire safety audit with an approved agency", "Refill and tag every extinguisher; test the hydrant system", "Apply on the municipal fire portal with the audit report", "Pay the fee and schedule the inspection", "Upload the renewed NOC and check the validity"]'::jsonb,'Without a valid Fire NOC the sites can be sealed, and insurance claims for fire may be refused.','[]'::jsonb,true),
('hwaste','Hazardous waste authorisation','hazardous','document',60,90,0,3,'State Pollution Control Board',2200000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('msds','MSDS register review','hazardous','document',12,30,0,2,'Internal · Safety Officer',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('extg','Fire extinguisher refill','hazardous','document',12,30,0,2,'Fire safety vendor',950000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('saudit','Third-party safety audit','hazardous','document',24,60,0,3,'Approved safety auditor',6500000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('fireins','Fire & special perils policy','insurance','document',12,45,0,3,'Insurer',21000000,'[]'::jsonb,NULL,'[{"key": "insurer", "label": "Insurer"}, {"key": "policy_number", "label": "Policy number"}, {"key": "sum_insured", "label": "Sum insured"}, {"key": "coverage", "label": "Coverage"}, {"key": "deductible", "label": "Deductible"}, {"key": "broker", "label": "Broker"}]'::jsonb,true),
('stockins','Stock insurance','insurance','document',12,45,0,3,'Insurer',8800000,'[]'::jsonb,NULL,'[{"key": "insurer", "label": "Insurer"}, {"key": "policy_number", "label": "Policy number"}, {"key": "sum_insured", "label": "Sum insured"}, {"key": "coverage", "label": "Coverage"}, {"key": "deductible", "label": "Deductible"}, {"key": "broker", "label": "Broker"}]'::jsonb,true),
('marine','Marine transit policy','insurance','document',12,45,0,3,'Insurer',6400000,'[]'::jsonb,NULL,'[{"key": "insurer", "label": "Insurer"}, {"key": "policy_number", "label": "Policy number"}, {"key": "sum_insured", "label": "Sum insured"}, {"key": "coverage", "label": "Coverage"}, {"key": "deductible", "label": "Deductible"}, {"key": "broker", "label": "Broker"}]'::jsonb,true),
('liab','Public liability policy','insurance','document',12,45,0,3,'Insurer',4200000,'[]'::jsonb,NULL,'[{"key": "insurer", "label": "Insurer"}, {"key": "policy_number", "label": "Policy number"}, {"key": "sum_insured", "label": "Sum insured"}, {"key": "coverage", "label": "Coverage"}, {"key": "deductible", "label": "Deductible"}, {"key": "broker", "label": "Broker"}]'::jsonb,true),
('health','Group health policy','insurance','document',12,45,0,2,'Insurer',38000000,'[]'::jsonb,NULL,'[{"key": "insurer", "label": "Insurer"}, {"key": "policy_number", "label": "Policy number"}, {"key": "sum_insured", "label": "Sum insured"}, {"key": "coverage", "label": "Coverage"}, {"key": "deductible", "label": "Deductible"}, {"key": "broker", "label": "Broker"}]'::jsonb,true),
('wc','Workmen compensation policy','insurance','document',12,45,0,3,'Insurer',5600000,'[]'::jsonb,NULL,'[{"key": "insurer", "label": "Insurer"}, {"key": "policy_number", "label": "Policy number"}, {"key": "sum_insured", "label": "Sum insured"}, {"key": "coverage", "label": "Coverage"}, {"key": "deductible", "label": "Deductible"}, {"key": "broker", "label": "Broker"}]'::jsonb,true),
('rc','Registration certificate','vehicles','document',180,60,0,2,'RTO',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('vins','Vehicle insurance','vehicles','document',12,30,0,3,'Insurer',3800000,'[]'::jsonb,NULL,'[{"key": "registration_number", "label": "Registration number"}, {"key": "policy_number", "label": "Policy number"}, {"key": "idv", "label": "IDV"}, {"key": "ncb", "label": "NCB %"}, {"key": "policy_type", "label": "Policy type"}]'::jsonb,true),
('puc','PUC certificate','vehicles','document',6,15,0,2,'Authorised PUC centre',30000,'[]'::jsonb,NULL,'[{"key": "registration_number", "label": "Registration number"}, {"key": "test_centre", "label": "Test centre"}, {"key": "reading", "label": "Reading"}]'::jsonb,true),
('fit','Fitness certificate','vehicles','document',12,30,0,3,'RTO',280000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('permit','National permit','vehicles','document',60,45,0,3,'RTO',1650000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('hgt','Hazardous goods transport licence','vehicles','document',12,45,0,4,'RTO · PESO',420000,'[]'::jsonb,'The tanker cannot carry hazardous goods. Dispatches on that vehicle stop.','[]'::jsonb,true),
('lease','Lease agreement','property','term_contract',36,90,0,3,'Landlord',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('rent','Leave & licence agreement','property','term_contract',11,60,0,2,'Landlord',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('proptax','Property tax','property','document',12,30,30,2,'Municipal Corporation',4200000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('dealer','Dealer agreement','contracts','term_contract',24,30,0,2,'Dealer',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('amc','Annual maintenance contract','contracts','term_contract',12,60,0,2,'Vendor',4800000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('vendor','Vendor supply contract','contracts','term_contract',24,60,0,2,'Vendor',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('nda','Non-disclosure agreement','contracts','term_contract',36,30,0,1,'Other party',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('transp','Transporter agreement','contracts','term_contract',12,45,0,3,'Transporter',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('tm','Trademark registration','ip','document',120,180,180,3,'Trade Marks Registry, Mumbai',900000,'[]'::jsonb,NULL,'[{"key": "application_number", "label": "Application number"}, {"key": "classes", "label": "Classes"}, {"key": "registry", "label": "Registry"}, {"key": "status", "label": "Status"}, {"key": "brand_covered", "label": "Brand covered"}]'::jsonb,true),
('copy','Copyright registration','ip','perpetual',0,0,0,1,'Copyright Office',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('design','Design registration','ip','document',120,180,0,2,'Patent Office',400000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('iso','ISO 9001 certificate','cert','document',36,90,0,3,'Certification body',12500000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('bis','BIS product certificate','cert','document',12,90,0,3,'Bureau of Indian Standards',3800000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('test','Product test report','cert','document',12,30,0,2,'NABL lab',650000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('odlimit','OD / CC limit renewal','banking','document',12,60,0,4,'Bank',8500000,'[]'::jsonb,'The working-capital limit runs out. Supplier payments and payroll depend on it.','[{"key": "sanctioned_limit", "label": "Sanctioned limit"}, {"key": "drawing_power", "label": "Drawing power"}, {"key": "security_offered", "label": "Security offered"}, {"key": "review_date", "label": "Review date"}]'::jsonb,true),
('bg','Bank guarantee','banking','document',12,45,0,3,'Bank',1200000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('kyc','Current account KYC re-check','banking','document',24,30,0,2,'Bank',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('dsc','Digital signature certificate','banking','document',24,30,0,3,'Certifying office',180000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('loan','Term loan','banking','term_contract',60,90,0,3,'Bank',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('domain','Domain registration','digital','subscription',12,30,30,3,'Registrar',110000,'[]'::jsonb,NULL,'[{"key": "registrar", "label": "Registrar"}, {"key": "nameservers", "label": "Nameservers"}, {"key": "registrant", "label": "Registrant"}, {"key": "transfer_lock", "label": "Transfer lock"}, {"key": "whois_privacy", "label": "WHOIS privacy"}, {"key": "dnssec", "label": "DNSSEC"}]'::jsonb,true),
('ssl','SSL certificate','digital','subscription',12,21,0,3,'Certificate office',0,'[]'::jsonb,NULL,'[{"key": "cn", "label": "CN"}, {"key": "sans", "label": "SANs"}, {"key": "ca", "label": "CA"}, {"key": "issuance_type", "label": "Issuance type"}, {"key": "fingerprint", "label": "Fingerprint"}]'::jsonb,true),
('cloud','Cloud hosting','digital','subscription',1,7,0,3,'Provider',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('saas','SaaS subscription','digital','subscription',12,30,0,2,'Provider',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('wsp','Email & workspace','digital','subscription',12,30,0,4,'Provider',0,'[]'::jsonb,'Email, calendar and every service that signs in with Google stop working.','[]'::jsonb,true),
('tally','Tally licence','software','perpetual',0,30,0,3,'Tally Solutions',2250000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('ms','Microsoft 365 licence','software','subscription',12,30,0,2,'Microsoft',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('av','Antivirus licence','software','subscription',12,30,0,2,'Vendor',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('dsn','Design software','software','subscription',12,30,0,1,'Vendor',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('incorp','Certificate of incorporation','corporate','perpetual',0,0,0,2,'Registrar of Companies',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('moa','MOA & AOA','corporate','perpetual',0,0,0,2,'Registrar of Companies',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('roc','Annual ROC filing','corporate','document',12,60,0,3,'Registrar of Companies',800000,'[]'::jsonb,NULL,'[]'::jsonb,true),
('auditor','Statutory auditor appointment','corporate','term_contract',60,90,0,2,'Board',0,'[]'::jsonb,NULL,'[]'::jsonb,true),
('resol','Board resolution register','corporate','perpetual',0,0,0,1,'Board',0,'[]'::jsonb,NULL,'[]'::jsonb,true)
ON CONFLICT ("code") DO NOTHING;
