-- PLANNED RE-ORDER LEVELS (0275) — ADDITIVE ONLY.
--
-- A raw-material level the planner keeps: rewritten nightly from the item's
-- own use and purchase history so the godown always holds a week and a half
-- of stock. Every level that exists today was typed by a person, so every
-- one starts `auto_managed = false` and the planner never touches it.
ALTER TABLE "erp_rm_levels" ADD COLUMN IF NOT EXISTS "auto_managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "erp_rm_levels" ADD COLUMN IF NOT EXISTS "plan" jsonb;--> statement-breakpoint
ALTER TABLE "erp_rm_levels" ADD COLUMN IF NOT EXISTS "planned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "erp_rm_levels" ADD COLUMN IF NOT EXISTS "ai_factor" numeric(6, 3);--> statement-breakpoint
ALTER TABLE "erp_rm_levels" ADD COLUMN IF NOT EXISTS "ai_reason" text;--> statement-breakpoint
ALTER TABLE "erp_rm_levels" ADD COLUMN IF NOT EXISTS "ai_reviewed_at" timestamp with time zone;
