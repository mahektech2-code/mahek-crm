-- Who asked for a customer to be deactivated, and when.
--
-- The request was a boolean and a reason. The asker's name lived only in the
-- notification text sent to managers — a sentence, in a table nobody joins,
-- that cannot be listed, sorted or aged. A manager could see that somebody
-- wanted a customer closed and had no way to find out who, or whether the ask
-- was from this morning or from March.
--
-- Additive and nullable, so the six requests already waiting keep working. They
-- carry null and the screen says "not recorded" rather than inventing a name;
-- the notification that carried it is still in `notifications`.
ALTER TABLE "customers" ADD COLUMN "deactivation_requested_by_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "deactivation_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "reactivation_requested_by_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "reactivation_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_deactivation_requested_by_id_users_id_fk" FOREIGN KEY ("deactivation_requested_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_reactivation_requested_by_id_users_id_fk" FOREIGN KEY ("reactivation_requested_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;