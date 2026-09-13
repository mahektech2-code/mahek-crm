-- WHY THE CUSTOMER RANG, WHO RANG, AND WHAT WE SAID WE WOULD DO.
--
-- The call panel asked one question — "what was the outcome?" — and made it do
-- two jobs. An outcome is how a call ENDED; a reason is what the customer
-- wanted when they picked up the phone, and on an inbound call the two are
-- routinely different. Everything below is null on every row that already
-- exists and nothing backfills any of it: guessing a reason from an outcome
-- would be wrong on exactly the calls the column exists to tell apart.

CREATE TYPE "public"."caller_role" AS ENUM(
  'owner', 'purchase', 'accounts', 'store', 'production', 'other'
);
--> statement-breakpoint

CREATE TYPE "public"."call_reason" AS ENUM(
  'place_order',
  'price_quotation',
  'product_enquiry',
  'stock_availability',
  'payment_outstanding',
  'delivery_transport',
  'complaint',
  'technical_support',
  'followup_previous',
  'other'
);
--> statement-breakpoint

ALTER TABLE "calls" ADD COLUMN "caller_role" "caller_role";--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "caller_name" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "call_reason" "call_reason";--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "reason_detail" jsonb;--> statement-breakpoint

-- A list, not one value: "send the price and have the salesman call in" is one
-- sentence a customer says and two things that have to happen.
ALTER TABLE "calls" ADD COLUMN "next_actions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "next_action_date" date;--> statement-breakpoint

-- Its own table and deliberately not a lead: a lead here is an account that has
-- never ordered, and an opportunity spotted on a call with a four-year customer
-- would make every reader of `customers.kind` wrong.
CREATE TABLE "call_opportunities" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL,
  "call_id" text NOT NULL,
  "user_id" text NOT NULL,
  "product" text NOT NULL,
  "estimated_quantity" text,
  "estimated_value_paise" bigint,
  "expected_order_date" date,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id" text
);
--> statement-breakpoint

ALTER TABLE "call_opportunities"
  ADD CONSTRAINT "call_opportunities_customer_id_customers_id_fk"
  FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "call_opportunities"
  ADD CONSTRAINT "call_opportunities_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "call_opportunities_customer_idx" ON "call_opportunities" ("customer_id");--> statement-breakpoint
CREATE INDEX "call_opportunities_call_idx" ON "call_opportunities" ("call_id");--> statement-breakpoint

-- FIVE OUTCOMES LOSE THEIR QUICK NOTES, because they now ask a coded question
-- and the chips were answers to that same question in different words.
--
-- "Price issue", "Stock sufficient", "Busy", "Switched Off", "Call Next Week",
-- "Using another brand", "Relationship Call" — every one of them is an answer
-- to the single-select field the outcome now carries. Keeping both made the
-- telecaller answer twice and let the two DISAGREE: a call coded `price_issue`
-- with a "Business slow" chip on it is a record nobody can read back, and
-- neither half of it is wrong.
--
-- DEACTIVATED, NEVER DELETED. Historical interactions hold these ids in
-- `quick_note_ids` and those references must keep resolving to something a
-- person can read — the save path deliberately does not check `active`, so an
-- old reference is never rejected on the way back out.
--
-- Two answers they carried and the coded lists did not — "Call Disconnected"
-- and "Waiting for quotation" — were added to those lists rather than lost.
UPDATE "quick_notes"
SET "active" = false
WHERE "outcome" IN ('no_order', 'no_answer', 'follow_up', 'not_interested', 'casual_talk');
