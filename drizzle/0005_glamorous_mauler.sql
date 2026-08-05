ALTER TABLE "follow_up_states" ADD COLUMN "manual_stage_floor" integer;--> statement-breakpoint
ALTER TABLE "follow_up_states" ADD COLUMN "floor_reason" text;--> statement-breakpoint
ALTER TABLE "follow_up_states" ADD COLUMN "floor_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "follow_up_states" ADD COLUMN "floor_set_by_id" text;--> statement-breakpoint
ALTER TABLE "follow_up_states" ADD CONSTRAINT "follow_up_states_floor_set_by_id_users_id_fk" FOREIGN KEY ("floor_set_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;