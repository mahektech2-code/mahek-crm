-- THE CALL ASSISTANT, and the two things it has to keep.
--
-- `call_ai_drafts` is one row per reading: the transcript in the language it
-- was spoken and in English (the client asked for the original to be kept for
-- later checking — the audio itself is still never stored), the proposal as
-- the card drew it, and the outcome the call was finally saved as. The gap
-- between what was suggested and what was saved is both the assistant's
-- accuracy and its next training example.
--
-- `call_intel_models` is the classifier trained nightly from logged calls, a
-- row per run so a model that got worse can be seen getting worse.
CREATE TABLE "call_ai_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"user_id" text NOT NULL,
	"call_id" text,
	"spoken" text DEFAULT '' NOT NULL,
	"english" text DEFAULT '' NOT NULL,
	"language" text,
	"heard_by" text,
	"reading" jsonb,
	"analysis" jsonb NOT NULL,
	"model" text,
	"classifier_label" text,
	"classifier_probability" double precision,
	"suggested_outcome" text,
	"applied_outcome" text,
	"saved_outcome" text,
	"saved_detail" jsonb,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"saved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "call_ai_drafts" ADD CONSTRAINT "call_ai_drafts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "call_ai_drafts" ADD CONSTRAINT "call_ai_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "call_ai_drafts_customer_idx" ON "call_ai_drafts" USING btree ("customer_id","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "call_ai_drafts_user_idx" ON "call_ai_drafts" USING btree ("user_id","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "call_ai_drafts_call_idx" ON "call_ai_drafts" USING btree ("call_id");
--> statement-breakpoint
CREATE TABLE "call_intel_models" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"model" jsonb NOT NULL,
	"trained_on" integer NOT NULL,
	"evaluation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "call_intel_models_kind_idx" ON "call_intel_models" USING btree ("kind","created_at" DESC);
--> statement-breakpoint
-- The assistant shows the model the past calls whose notes read most like
-- this one — `order by notes <-> $text`, a trigram nearest-neighbour lookup.
-- GiST rather than GIN because only GiST can ORDER BY distance from an
-- index; without it every request would read every note ever written. Not in
-- schema.ts, for the same reason the product search's trigram indexes are
-- not: drizzle cannot express an operator-class index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calls_notes_trgm_idx" ON "calls" USING gist ("notes" gist_trgm_ops);
