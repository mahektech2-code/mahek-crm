CREATE TYPE "public"."credit_note_status" AS ENUM('requested', 'under_review', 'approved', 'rejected', 'issued');--> statement-breakpoint
ALTER TABLE "complaints" ADD COLUMN "cn_amount" bigint;--> statement-breakpoint
ALTER TABLE "complaints" ADD COLUMN "cn_status" "credit_note_status";--> statement-breakpoint
ALTER TABLE "complaints" ADD COLUMN "cn_reference" text;