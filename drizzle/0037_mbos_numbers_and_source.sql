-- Three schema gaps the field app was working around, closed.
--
-- 1. An order number and a receipt number had nowhere to live, so the sync
--    wrote the order number into `orders.external_ref` and the receipt number
--    into `payments.external_ref` AND onto the front of the receipt's note.
--    A number prefixed onto a free-text field is a number nothing can query,
--    and a note that reads "Receipt MRCP/26-27/0007 — shop was shut" is a
--    sentence the salesman did not write.
--
-- 2. `order_source` had no `mbos`, so field orders were being stored as `crm`.
--    `external` means the external ORDER SYSTEM the office types into, so
--    neither existing value was true and every report split by source lied.
--
-- 3. `timeline_events` had no natural key, so nothing could project into it
--    twice safely — and the backfill of five years of calls is going to be run
--    twice by somebody.
--
-- THE ENUM VALUE IS ADDED HERE AND USED NOWHERE IN THIS FILE. Postgres refuses
-- to let a value added to an enum be USED in the transaction that adds it, and
-- drizzle-kit applies every pending migration in ONE transaction — so the data
-- update that reclassifies existing field orders lives in 0039, behind a guard
-- explained there.
ALTER TYPE "public"."order_source" ADD VALUE 'mbos';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "order_no" text;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD COLUMN "receipt_no" text;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_order_no_key" ON "orders" USING btree ("order_no");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_receipts_receipt_no_key" ON "payment_receipts" USING btree ("receipt_no");--> statement-breakpoint
-- One projection per source row per kind of event, per app. Nulls stay
-- distinct, which is what a unique index does with them by default: an event
-- with no source row is not a projection of anything and cannot collide.
CREATE UNIQUE INDEX "timeline_events_natural_key" ON "timeline_events" USING btree ("source_app","event_type","source_record_id");
