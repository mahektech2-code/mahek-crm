-- The funnel's vocabulary, and NOTHING that spends it.
--
-- Mahek's specification replaces one six-rung ladder with three: thirteen rungs
-- for a direct customer, ten for appointing a distributor, twelve for a shop
-- served through one. Every rung below is added to the enum that already holds
-- the six, because a lead is still one `customers` row and its stage is still
-- one column — see 0094, which is where that stopped being two tables.
--
-- THIS FILE ADDS VALUES AND USES NONE OF THEM, and that split is the whole
-- reason it exists. Postgres will not let a value added to an enum be USED in
-- the transaction that added it, and drizzle-kit applies every pending
-- migration in ONE transaction — so a default, a backfill or a CHECK naming
-- `'suspect'` in the same file fails on every database that has not already
-- been through this one. It is the same trap the app-id enum hit when a new app
-- was granted in the migration that declared it. 0097 is where they are spent.
--
-- The original six are untouched and stay first. A lead with no
-- `lead_sales_type` climbs exactly those, so no existing row, no console
-- funnel and no cohort conversion figure moved on the day this landed.
--
-- Idempotent throughout: `IF NOT EXISTS` on ADD VALUE is supported from PG 12
-- and this deployment is 16.
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'suspect';--> statement-breakpoint
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'prospect';--> statement-breakpoint
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'qualification';--> statement-breakpoint
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'sample_trial';--> statement-breakpoint
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'sample_received';--> statement-breakpoint
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'sample_review';--> statement-breakpoint
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'first_order';--> statement-breakpoint
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'delivery';--> statement-breakpoint
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'payment';--> statement-breakpoint
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'second_order';--> statement-breakpoint
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'customer';--> statement-breakpoint
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'management_review';--> statement-breakpoint
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'commercial_discussion';--> statement-breakpoint
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'distributor_approval';--> statement-breakpoint
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'distributor_agreement';--> statement-breakpoint
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'initial_stock_order';--> statement-breakpoint
ALTER TYPE "mbos_lead_stage" ADD VALUE IF NOT EXISTS 'active_distributor';--> statement-breakpoint

-- §12 — appointing a distributor is a decision a salesman may never take alone,
-- and it routes through the approvals table every other MBOS decision already
-- uses. `step_index` 0 is the sales manager, 1 is management; nothing new is
-- needed for the chain itself.
ALTER TYPE "mbos_approval_type" ADD VALUE IF NOT EXISTS 'distributor_appointment';--> statement-breakpoint

-- §14 — the two categories the manager's communication buttons need. They were
-- all landing in `marketing`, which held brochures, videos and profiles
-- together with nothing to tell them apart, so "Send the company profile" had
-- nothing it could reliably reach for.
ALTER TYPE "mbos_document_category" ADD VALUE IF NOT EXISTS 'company_profile';--> statement-breakpoint
ALTER TYPE "mbos_document_category" ADD VALUE IF NOT EXISTS 'product_video';--> statement-breakpoint

-- §15 — the third answer a trial can give. "They want to test it again on a
-- different substrate" is neither approval nor rejection, and recording it as
-- `pending` loses the fact that a trial happened at all and produced an opinion.
ALTER TYPE "mbos_sample_outcome" ADD VALUE IF NOT EXISTS 'more_testing';
