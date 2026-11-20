-- A Studio bulk run and an Upload & Bulk Forward can be CANCELLED.
--
-- Nothing MahekOne does sends anything (a poster leaves by download or by a
-- WhatsApp chat a person opens), so cancelling never unsends: a bulk run's
-- posters nobody has shared yet leave the lists (`removed_at`, as Remove does)
-- and the shared ones stay; a forward stops offering its remaining
-- recipients and every recipient keeps the status the person gave it.
ALTER TABLE "studio_batches" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "studio_batches" ADD COLUMN IF NOT EXISTS "cancelled_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "studio_forwards" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "studio_forwards" DROP CONSTRAINT IF EXISTS "studio_forwards_status";
--> statement-breakpoint
ALTER TABLE "studio_forwards" ADD CONSTRAINT "studio_forwards_status" CHECK ("status" in ('draft','started','cancelled'));
