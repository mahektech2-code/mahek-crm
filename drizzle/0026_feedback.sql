CREATE TYPE "public"."feedback_kind" AS ENUM('bug', 'suggestion', 'feature', 'question');
--> statement-breakpoint
CREATE TYPE "public"."feedback_status" AS ENUM('new', 'in_progress', 'done', 'declined');
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" "feedback_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"path" text,
	"app" text,
	"user_agent" text,
	"status" "feedback_status" DEFAULT 'new' NOT NULL,
	"admin_note" text,
	"handled_by_id" text,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_handled_by_id_users_id_fk" FOREIGN KEY ("handled_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "feedback_status_idx" ON "feedback" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX "feedback_user_idx" ON "feedback" USING btree ("user_id","created_at");
