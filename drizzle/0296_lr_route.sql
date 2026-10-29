-- AN LR HAS A ROUTE. Where the transporter dispatched it from, each city it has
-- reached on the way (one event per city, dated the day it got there), the city
-- it is going to, and — when the party collects it themselves — where it waits
-- and whom to ask. All optional: a consignment updated before this has none and
-- reads exactly as it did.
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "dispatched_from" text;
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "current_city" text;
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "destination" text;
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "pickup_point" text;
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD COLUMN IF NOT EXISTS "pickup_contact" text;
--> statement-breakpoint
ALTER TABLE "erp_transport_events" ADD COLUMN IF NOT EXISTS "city" text;
--> statement-breakpoint
-- "Ready for Pickup": waiting at the transporter's office for the party to
-- collect — the other way the last mile goes, beside "Out for Delivery".
ALTER TABLE "erp_transports" DROP CONSTRAINT IF EXISTS "erp_transports_stage_check";
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD CONSTRAINT "erp_transports_stage_check"
  CHECK ("material_stage" in ('Dispatched', 'At transport', 'In Transit', 'On the way to Destination area', 'Reached Destination Area', 'Out for Delivery', 'Ready for Pickup', 'Close - Received to Party'));
