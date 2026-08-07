CREATE TYPE "public"."attachment_parent" AS ENUM('interaction', 'complaint', 'follow_up_attempt');--> statement-breakpoint
CREATE TYPE "public"."attachment_status" AS ENUM('uploading', 'available', 'failed', 'removed');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_type" "attachment_parent",
	"parent_id" text,
	"filename" text NOT NULL,
	"stored_ref" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"thumbnail_ref" text,
	"status" "attachment_status" DEFAULT 'uploading' NOT NULL,
	"uploaded_by_id" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_parent_idx" ON "attachments" USING btree ("parent_type","parent_id");--> statement-breakpoint
CREATE INDEX "attachments_orphan_idx" ON "attachments" USING btree ("parent_id","uploaded_at");