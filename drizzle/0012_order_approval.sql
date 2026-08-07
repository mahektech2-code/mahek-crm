ALTER TYPE "public"."order_status" ADD VALUE 'pending_approval' BEFORE 'confirmed';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'declined' BEFORE 'confirmed';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'accounts' BEFORE 'admin';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "approved_by_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "decline_reason" text;